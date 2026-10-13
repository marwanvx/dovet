import type { Exchange } from "./nvidia-scenarios.ts";

/** Replays recorded exchanges in order on 127.0.0.1 (testing "Test layers": recorded-stream integration). */
export function startFixtureServer(exchanges: readonly Exchange[]): {
  baseURL: string;
  received: string[];
  stop(): Promise<void>;
} {
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      received.push(await req.text());
      const next = exchanges[received.length - 1];
      if (next === undefined) return new Response("fixture server: no more recorded exchanges", { status: 599 });
      return new Response(next.response.body, {
        status: next.response.status,
        headers: { "content-type": next.response.contentType },
      });
    },
  });
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, received, stop: () => server.stop(true) };
}
