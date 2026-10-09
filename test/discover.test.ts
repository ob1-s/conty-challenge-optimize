import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, FIXTURE_SEED, seed } from "../src/seed.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/page-1.json", import.meta.url), "utf8"),
) as unknown;

function setup() {
  const db = openDatabase(":memory:");
  seed(db, FIXTURE_SEED);
  resetQueryCount();
  return createApp(db);
}

describe("descoberta de criadores", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = setup();
  });

  it("devolve a primeira página combinada com a campanha", async () => {
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fixture);
  });

  it("responde a página de 20 com no máximo 8 queries", async () => {
    resetQueryCount();
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });

  it("responde 404 quando a campanha não existe", async () => {
    const res = await app.request("/campaigns/cmp_missing/creators");
    expect(res.status).toBe(404);
  });

  it("mantém o teto de queries com 600 criadores", async () => {
    const db = openDatabase(":memory:");
    seed(db, { creators: 600, seed: 7 });
    const big = createApp(db);
    resetQueryCount();
    const res = await big.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });
});

type Page = {
  total: number;
  creators: Array<{ id: string; niche_score: number; latest_reach: number; deliveries_90d: number }>;
};

describe("casos de borda da listagem", () => {
  function edgeApp() {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_edge', 'Borda', '["beleza","moda"]');
      INSERT INTO creators VALUES
        ('crt_a', 'Empate', '["beleza"]', ''),
        ('crt_b', 'Sem conta', '["beleza"]', ''),
        ('crt_c', 'Conta sem métrica', '["beleza"]', ''),
        ('crt_d', 'Entrega no limite', '["moda"]', ''),
        ('crt_e', 'Fora do nicho', '["games"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_a', 'crt_a', 'instagram'),
        ('acc_c', 'crt_c', 'instagram'),
        ('acc_e', 'crt_e', 'instagram');
      INSERT INTO metrics VALUES
        ('met_a1', 'acc_a', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_a2', 'acc_a', 99, '2026-05-30T00:00:00.000Z', ''),
        ('met_a0', 'acc_a', 500, '2026-05-01T00:00:00.000Z', ''),
        ('met_e1', 'acc_e', 777, '2026-05-30T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_d1', 'crt_d', '2026-03-03T12:00:00.000Z'),
        ('del_d2', 'crt_d', '2026-03-03T11:59:59.999Z');
    `);
    return createApp(db);
  }

  async function page(app: ReturnType<typeof createApp>, query = ""): Promise<Page> {
    const res = await app.request(`/campaigns/cmp_edge/creators${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  }

  it("desempata a métrica mais recente pelo id decrescente", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_a")?.latest_reach).toBe(99);
  });

  it("lista quem não tem conta ou métrica com alcance zero e deixa de fora score zero", async () => {
    const result = await page(edgeApp());
    expect(result.creators.map((creator) => creator.id)).toEqual(["crt_a", "crt_b", "crt_c", "crt_d"]);
    expect(result.creators.find((creator) => creator.id === "crt_b")?.latest_reach).toBe(0);
    expect(result.creators.find((creator) => creator.id === "crt_c")?.latest_reach).toBe(0);
  });

  it("conta a entrega exatamente no limite dos 90 dias e não a de 1 ms antes", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_d")?.deliveries_90d).toBe(1);
  });

  it("mantém o total quando o offset passa do fim", async () => {
    const result = await page(edgeApp(), "?limit=20&offset=50");
    expect(result.creators).toEqual([]);
    expect(result.total).toBe(4);
  });

  it("soma a última métrica de cada conta sem multiplicar as entregas", async () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_edge', 'Contas', '["beleza"]');
      INSERT INTO creators VALUES ('crt_a', 'Duas contas', '["beleza"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_a', 'crt_a', 'instagram'),
        ('acc_b', 'crt_a', 'tiktok');
      INSERT INTO metrics VALUES
        ('met_a_old', 'acc_a', 900, '2026-05-01T00:00:00.000Z', ''),
        ('met_a_new', 'acc_a', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_b_old', 'acc_b', 800, '2026-05-01T00:00:00.000Z', ''),
        ('met_b_new', 'acc_b', 20, '2026-05-30T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_a1', 'crt_a', '2026-05-01T00:00:00.000Z'),
        ('del_a2', 'crt_a', '2026-05-02T00:00:00.000Z');
    `);

    try {
      const result = await page(createApp(db));
      expect(result.creators).toEqual([
        {
          id: "crt_a",
          name: "Duas contas",
          niche_score: 1,
          latest_reach: 30,
          deliveries_90d: 2,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("preserva ordem, total e teto de queries nas páginas de uma população maior", async () => {
    const db = openDatabase();
    db.exec(`INSERT INTO campaigns VALUES ('cmp_edge', 'Páginas', '["beleza","moda"]')`);
    const expected = [
      {
        id: "crt_priority",
        name: "Dois nichos",
        niche_score: 2,
        latest_reach: 0,
        deliveries_90d: 0,
      },
    ];

    for (let i = 0; i < 125; i += 1) {
      expected.push({
        id: `crt_${String(i).padStart(3, "0")}`,
        name: `Criador ${i}`,
        niche_score: 1,
        latest_reach: 0,
        deliveries_90d: 0,
      });
    }

    const insert = db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')");
    for (const creator of [...expected].reverse()) {
      const niches = creator.niche_score === 2 ? ["beleza", "moda"] : ["beleza"];
      insert.run(creator.id, creator.name, JSON.stringify(niches));
    }
    insert.run("crt_other", "Outro nicho", '["games"]');

    try {
      const app = createApp(db);
      for (const offset of [0, 20, 120, 126, 200]) {
        resetQueryCount();
        const result = await page(app, `?limit=20&offset=${offset}`);

        expect(result).toEqual({
          campaign_id: "cmp_edge",
          total: 126,
          creators: expected.slice(offset, offset + 20),
        });
        expect(getQueryCount()).toBeLessThanOrEqual(8);
      }
    } finally {
      db.close();
    }
  });
});
