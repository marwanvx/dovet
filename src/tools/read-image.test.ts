import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testGif, testPng } from "../../test/helpers/index.ts";
import type { EventEnvelope } from "../schema/index.ts";
import { createReadTool, createToolRegistry, type MediaContext, type ToolContext, type ToolOutput } from "./index.ts";
import { createMediaBudget } from "./media-budget.ts";
import { context, text, workspace } from "./test-context.ts";

async function read(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const tool = createReadTool();
  const prepared = createToolRegistry([tool]).prepare("Read", input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, ctx);
}

function media(over: Partial<MediaContext> & { stored?: Uint8Array[] } = {}): MediaContext {
  const stored = over.stored ?? [];
  return {
    images: true,
    longEdge: 2000,
    claim: () => undefined,
    store: (bytes) => {
      stored.push(bytes);
      return `${stored.length}`.padStart(64, "0");
    },
    ...over,
  };
}

const imageOf = (out: ToolOutput) => out.content.find((p) => p.kind === "image");

describe("Read: images", () => {
  // spec: AC-TOOLS-20
  test("a 4000×3000 PNG is sent at no more than 2,000 px on the long edge and 500 KB", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "big.png"), testPng(4000, 3000));
    const stored: Uint8Array[] = [];
    const out = await read(context(cwd, { media: media({ stored }) }), { file_path: "big.png" });
    expect(out.status).toBe("ok");
    const sent = stored[0];
    if (sent === undefined) throw new Error("nothing stored");
    const meta = await new Bun.Image(sent).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(2000);
    expect(meta.height).toBe(1500);
    expect(sent.length).toBeLessThanOrEqual(500 * 1024);
    expect(text(out)).toContain("4000×3000");
  });

  // spec: AC-TOOLS-20
  test("a photo-like PNG over 500 KB is re-encoded as JPEG, never below quality 70, and stays under the hard cap", async () => {
    const cwd = await workspace();
    const png = testPng(2400, 1800, 12);
    await writeFile(join(cwd, "photo.png"), png);
    const stored: Uint8Array[] = [];
    const out = await read(context(cwd, { media: media({ stored }) }), { file_path: "photo.png" });
    expect(out.status).toBe("ok");
    expect(imageOf(out)?.mediaType).toBe("image/jpeg");
    const sent = stored[0] ?? new Uint8Array();
    const q70 = await new Bun.Image(png).resize(2000, 2000, { fit: "inside" }).jpeg({ quality: 70 }).bytes();
    expect(sent.length).toBeGreaterThanOrEqual(q70.length);
    expect(sent.length).toBeLessThan(5 * 1024 * 1024);
    expect(sent.length).toBeLessThan(png.length);
  });

  // spec: AC-TOOLS-20
  test("a standard-tier model gets no more than its native long edge", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "big.png"), testPng(3000, 2000));
    const stored: Uint8Array[] = [];
    await read(context(cwd, { media: media({ stored, longEdge: 1568 }) }), { file_path: "big.png" });
    const meta = await new Bun.Image(stored[0] ?? new Uint8Array()).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(1568);
  });

  test("a small image is sent as it is", async () => {
    const cwd = await workspace();
    const png = testPng(300, 200);
    await writeFile(join(cwd, "small.png"), png);
    const stored: Uint8Array[] = [];
    const out = await read(context(cwd, { media: media({ stored }) }), { file_path: "small.png" });
    expect(imageOf(out)?.mediaType).toBe("image/png");
    expect(stored[0]).toEqual(png);
    expect(text(out)).toContain("Sent as it is.");
  });

  test("an animated GIF is sent as its first frame and says so; a still GIF does not", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "anim.gif"), testGif(3));
    await writeFile(join(cwd, "still.gif"), testGif(1));
    const animated = await read(context(cwd, { media: media() }), { file_path: "anim.gif" });
    const still = await read(context(cwd, { media: media() }), { file_path: "still.gif" });
    expect(animated.status).toBe("ok");
    expect(imageOf(animated)?.mediaType).toBe("image/png");
    expect(text(animated)).toContain("Animated GIF: only the first frame is shown.");
    expect(text(still)).not.toContain("Animated");
  });

  // spec: AC-TOOLS-35
  test("an image that fails to decode is refused and nothing is stored or counted", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "cut.png"), testPng(800, 600).subarray(0, 3000));
    await writeFile(join(cwd, "fake.png"), "this is not a picture");
    const stored: Uint8Array[] = [];
    let claims = 0;
    const ctx = context(cwd, {
      media: media({
        stored,
        claim: () => {
          claims += 1;
          return undefined;
        },
      }),
    });
    for (const file of ["cut.png", "fake.png"]) {
      const out = await read(ctx, { file_path: file });
      expect(out.status).toBe("error");
      expect(text(out)).toContain("could not be decoded as an image");
      expect(text(out)).toContain("it was not sent");
    }
    expect(stored).toEqual([]);
    expect(claims).toBe(0);
  });

  test("a file declaring more pixels than the limit is refused before it is decoded", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "huge.png"), testPng(9000, 8000).subarray(0, 100));
    const out = await read(context(cwd, { media: media() }), { file_path: "huge.png" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("million pixels");
  });

  test("a model that cannot view images is told so before the file is read", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.png"), testPng(10, 10));
    for (const ctx of [context(cwd), context(cwd, { media: media({ images: false }) })]) {
      const out = await read(ctx, { file_path: "a.png" });
      expect(out.status).toBe("error");
      expect(text(out)).toBe("The current model can't view images.");
    }
  });

  // spec: AC-TOOLS-35
  test("the budget's refusal reaches the model and stores nothing", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.png"), testPng(300, 200));
    const stored: Uint8Array[] = [];
    const out = await read(
      context(cwd, {
        media: media({
          stored,
          claim: () => "Too many images in this conversation (100). Run /compact or start a new session to view more.",
        }),
      }),
      { file_path: "a.png" },
    );
    expect(out.status).toBe("error");
    expect(text(out)).toContain("Run /compact");
    expect(stored).toEqual([]);
  });
});

function resultEvent(turn: number, epoch: number, bytes: number[]): EventEnvelope {
  return {
    v: 1,
    id: `E${turn}${epoch}${bytes.length}`,
    seq: turn,
    ts: "2026-10-21T00:00:00.000Z",
    type: "tool.result",
    epoch,
    turn,
    data: {
      callId: `c${turn}`,
      status: "ok",
      output: "ok",
      media: bytes.map((b) => ({
        kind: "image",
        blob: { store: "blob", id: "a".repeat(64) },
        mediaType: "image/png",
        bytes: b,
      })),
    },
  } as unknown as EventEnvelope;
}

describe("media budget", () => {
  // spec: AC-TOOLS-35
  test("stops accepting images at 60% of the request cap, counting base64, and a session of screenshots stays under the cap", () => {
    const events: EventEnvelope[] = [];
    const cap = 10_000_000;
    const budget = createMediaBudget(events, () => 1, { requestCapBytes: cap, maxImages: null });
    let accepted = 0;
    for (let turn = 1; turn <= 100; turn += 1) {
      const refusal = budget.claim(450_000);
      if (refusal !== undefined) {
        expect(refusal).toContain("/compact");
        break;
      }
      events.push(resultEvent(turn, 1, [450_000]));
      budget.settle();
      accepted += 1;
    }
    expect(accepted).toBe(Math.floor((cap * 0.6) / 600_000));
    expect(accepted * 600_000).toBeLessThanOrEqual(cap * 0.6);
  });

  // spec: AC-TOOLS-35
  test("parallel reads in one batch count each other before their results are logged", () => {
    const budget = createMediaBudget([], () => 1, { requestCapBytes: 1_000_000, maxImages: 2 });
    expect(budget.claim(1000)).toBeUndefined();
    expect(budget.claim(1000)).toBeUndefined();
    expect(budget.claim(1000)).toContain("Too many images in this conversation (2)");
    budget.settle();
    expect(budget.claim(1000)).toBeUndefined();
  });

  // spec: AC-TOOLS-35
  test("a new epoch and a cancelled turn do not count", () => {
    const events: EventEnvelope[] = [
      resultEvent(1, 1, [100_000]),
      resultEvent(2, 2, [100_000]),
      {
        v: 1,
        id: "T",
        seq: 9,
        ts: "2026-10-21T00:00:00.000Z",
        type: "turn.end",
        epoch: 2,
        turn: 2,
        data: { reason: "cancelled" },
      } as unknown as EventEnvelope,
    ];
    const budget = createMediaBudget(events, () => 2, { requestCapBytes: 1_000_000, maxImages: 1 });
    expect(budget.claim(1000)).toBeUndefined();
  });
});
