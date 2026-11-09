export function requireCandidateServer(url, expectedSha, observedSha) {
  const target = new URL(url);
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.username || target.password)
    throw new Error("Release browser journeys must use an isolated loopback server.");
  if (!/^[a-f0-9]{40}$/i.test(expectedSha) || observedSha !== expectedSha)
    throw new Error("The browser server does not report the exact candidate source revision.");
}
