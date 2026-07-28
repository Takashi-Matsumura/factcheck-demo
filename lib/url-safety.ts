// SSRF (Server-Side Request Forgery) 対策。
//
// このアプリはユーザーが指定した URL (manualUrls) や検索結果の URL を
// サーバー側の Playwright ブラウザで開いてスクリーンショットを撮る。
// 検証を挟まないと、クラウドのメタデータエンドポイント (169.254.169.254)、
// 社内ネットワーク、あるいはこのマシン自身が動かしている llama-server 等の
// 内部サービスへ誘導され、その画面をスクリーンショットとして持ち出されてしまう。
//
// そのため実際にページを開く直前に、ホスト名を DNS 解決した上で
// ループバック/プライベート/リンクローカル等のアドレスへは接続させない。

import dns from "node:dns/promises";
import net, { BlockList } from "node:net";

export class UnsafeUrlError extends Error {}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

const ipv4BlockList = new BlockList();
ipv4BlockList.addRange("0.0.0.0", "0.255.255.255", "ipv4"); // "this" network
ipv4BlockList.addRange("10.0.0.0", "10.255.255.255", "ipv4");
ipv4BlockList.addRange("100.64.0.0", "100.127.255.255", "ipv4"); // CGNAT
ipv4BlockList.addRange("127.0.0.0", "127.255.255.255", "ipv4"); // loopback
ipv4BlockList.addRange("169.254.0.0", "169.254.255.255", "ipv4"); // link-local (クラウドメタデータ含む)
ipv4BlockList.addRange("172.16.0.0", "172.31.255.255", "ipv4");
ipv4BlockList.addRange("192.168.0.0", "192.168.255.255", "ipv4");
ipv4BlockList.addRange("198.18.0.0", "198.19.255.255", "ipv4"); // ベンチマーク用
ipv4BlockList.addRange("224.0.0.0", "255.255.255.255", "ipv4"); // マルチキャスト/予約

const ipv6BlockList = new BlockList();
ipv6BlockList.addSubnet("::1", 128, "ipv6"); // loopback
ipv6BlockList.addSubnet("fe80::", 10, "ipv6"); // link-local
ipv6BlockList.addSubnet("fc00::", 7, "ipv6"); // unique local (fc00::/7)

/**
 * ::ffff:a.b.c.d 形式の IPv4-mapped IPv6 アドレスから埋め込まれた IPv4 部分を取り出す。
 * new URL() が生成する正規化形式 (例: "::ffff:7f00:1") に対応する。
 */
function extractMappedIPv4(v6: string): string | null {
  const m = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIp(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "");
  if (net.isIPv4(host)) {
    return ipv4BlockList.check(host, "ipv4");
  }
  if (net.isIPv6(host)) {
    if (ipv6BlockList.check(host, "ipv6")) return true;
    const mapped = extractMappedIPv4(host);
    if (mapped) return ipv4BlockList.check(mapped, "ipv4");
    return false;
  }
  // IP として解釈できない文字列は安全側に倒して拒否する
  return true;
}

/**
 * 外部への http/https 到達可能な公開 URL であることを検証する。
 * 問題があれば UnsafeUrlError を投げる。呼び出し側は個別ソースのスキップ等に使う。
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("URLの形式が不正です");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("http/https 以外のURLは指定できません");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("認証情報を含むURLは指定できません");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError("このホストは指定できません");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new UnsafeUrlError("プライベート/ローカルなアドレスは指定できません");
    }
    return url;
  }

  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new UnsafeUrlError("ホスト名を解決できませんでした");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a))) {
    throw new UnsafeUrlError("このホストの参照先はアクセスできません");
  }

  return url;
}
