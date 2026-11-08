import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DrawReceiptPanel } from "../../src/components/player/DrawStudio";
import type { DrawPhase, DrawReceipt } from "../../src/components/player/draw-studio-state";

const receipt: DrawReceipt = {
  draw_id: "draw-test",
  instance_id: "instance-test",
  card_name: "Secret Subject",
  edition_name: "Card — Secret Edition",
  variant_name: "Holographic",
  render_url: "/secret-front.webp",
  serial: "SECRET-SERIAL",
  new_subject: true,
  new_finish: true,
  owned_copies: 1,
  price: 80,
  balance_after: 420,
  probability_bps: 5000,
  pool_revision: 1,
  random_commitment: "test-commitment",
  replayed: false,
};

const noop = () => {};

function renderPanel(
  status: "committed" | "replay" | "hidden" | "revealed",
  drawReceipt = receipt,
) {
  const waiting = status === "committed" || status === "replay";
  const visible = status === "revealed";
  const phase = {
    status: status === "committed" ? "committed" : "revealed",
    receipt: drawReceipt,
    source: "draw",
    visible,
    replaying: status === "replay",
    operation: {},
  } as Extract<DrawPhase, { status: "committed" | "revealed" }>;
  return renderToStaticMarkup(
    React.createElement(DrawReceiptPanel, {
      receipt: drawReceipt,
      phase,
      visible,
      waitingForReveal: waiting,
      revealRef: { current: null },
      onShowNow: noop,
      onReplay: noop,
      onToggleVisible: noop,
      onOpenAnother: noop,
    }),
  );
}

const secrets = [
  "Secret Subject",
  "Secret Edition",
  "Holographic",
  "SECRET-SERIAL",
  "/secret-front.webp",
  "New subject",
];

describe("draw reveal presentation", () => {
  for (const status of ["committed", "replay"] as const) {
    it(`keeps result text and result-specific media out of the ${status} markup`, () => {
      const html = renderPanel(status);
      assert.ok(html.includes("A face-down Foilbury card"));
      assert.ok(html.includes("Reveal card"));
      for (const secret of secrets) {
        assert.ok(!html.includes(secret), `Unexpected result detail: ${secret}`);
      }
    });
  }

  it("hides the front and result details until the player chooses Show", () => {
    const html = renderPanel("hidden");
    for (const secret of secrets) {
      assert.ok(!html.includes(secret), `Unexpected hidden detail: ${secret}`);
    }
    assert.ok(html.includes("A face-down Foilbury card"));
    assert.ok(html.includes("Show"));
  });

  it("shows the exact card and owned-result feedback after the reveal", () => {
    const html = renderPanel("revealed");
    for (const expected of secrets) {
      assert.ok(html.includes(expected), `Missing result detail: ${expected}`);
    }
  });
});
