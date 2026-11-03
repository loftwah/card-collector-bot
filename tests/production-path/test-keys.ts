/**
 * Test-owned Ed25519 key pair. It is used only by the isolated production-path
 * Worker test. Production signature verification is unchanged and no Worker
 * test-key bypass exists.
 */
export const TEST_DISCORD_PUBLIC_KEY_HEX =
  "d1774c253eff67e195362c3108fb3596a536e4dcec3a551589495d496249c740";

export const TEST_DISCORD_PRIVATE_JWK = {
  crv: "Ed25519",
  d: "LwDRultr852tRgUmGko7GxWYbrWA-uJ2HMgojYQ3Ua8",
  x: "0XdMJT7_Z-GVNiwxCPs1lqU25NzsOlUViUldSWJJx0A",
  kty: "OKP",
} as const;
