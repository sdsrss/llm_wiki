#!/usr/bin/env node
// Build a SYNTHETIC KB tier of arbitrary size for retrieval-scaling studies (C9).
// node_modules only yields ~355 candidate .md files, so make-corpus.mjs caps out
// below 500; this generator produces N deterministic pages plus matching probes so
// the BM25-vs-vector reversal point can be measured well past 500 pages.
//
// Method: each page is a unique (feature, component) word-pair "subsystem" with a
// throughput fact (numeric, seed-varied; the PAIR is the unique identity, not the
// number). Words come from small pools (50×50 = 2500 unique pairs), so
// each individual token repeats across ~N/50 pages — that shared vocabulary is the
// BM25 distractor pressure that grows with N. Two probe variants per sampled page:
//   - fact (en): names the pair in English → BM25-favorable same-language retrieval.
//   - xlang (zh): names the pair via Chinese glosses only → ZERO English-token overlap
//     with the page, so BM25 has no lexical signal and a multilingual vector must bridge.
// Deterministic (seeded), zero network. Vectors: run `llm-wiki embed` after (local or API).
//
// Usage: node scripts/eval/make-synthetic-corpus.mjs --tier 1000 \
//          [--out scripts/eval/corpus/kb-synth-1000] \
//          [--probes-out scripts/eval/probes-synth-1000.jsonl] [--sample 60] [--seed 1]
import fs from 'node:fs'
import path from 'node:path'
import { buildIndex } from '../../src/indexer.mjs'

const CORPUS_DATE = '2026-07-12' // fixed: corpora must be byte-reproducible

// feature word (en) -> zh gloss
const FEATURES = {
  cache: '缓存', queue: '队列', stream: '流式', buffer: '缓冲', index: '索引',
  router: '路由', parser: '解析', scheduler: '调度', sampler: '采样', encoder: '编码',
  decoder: '解码', filter: '过滤', mapper: '映射', reducer: '归并', planner: '规划',
  tracker: '追踪', monitor: '监控', limiter: '限流', balancer: '均衡', resolver: '解析器',
  validator: '校验', serializer: '序列化', compressor: '压缩', allocator: '分配', collector: '回收',
  dispatcher: '派发', aggregator: '聚合', replicator: '复制', partitioner: '分区', throttler: '节流',
  hasher: '哈希', batcher: '批处理', prefetcher: '预取', deduplicator: '去重', reranker: '重排',
  tokenizer: '分词', embedder: '嵌入', retriever: '检索', ranker: '排序', splitter: '切分',
  merger: '合并', pruner: '剪枝', compactor: '压实', flusher: '刷写', warmer: '预热',
  sharder: '分片', rebalancer: '再均衡', gossiper: '流言', quorum: '仲裁', watermarker: '水位',
}
// component word (en) -> zh gloss
const COMPONENTS = {
  registry: '注册表', gateway: '网关', pipeline: '流水线', ledger: '账本', kernel: '内核',
  daemon: '守护', socket: '套接字', session: '会话', cluster: '集群', shard: '分片',
  replica: '副本', snapshot: '快照', journal: '日志', manifest: '清单', digest: '摘要',
  token: '令牌', cursor: '游标', channel: '通道', bucket: '桶', segment: '段',
  region: '区域', tenant: '租户', namespace: '命名空间', partition: '分区', lease: '租约',
  epoch: '纪元', frontier: '前沿', backlog: '积压', watchdog: '看门狗', arbiter: '仲裁者',
  broker: '代理', coordinator: '协调器', executor: '执行器', supervisor: '监督者', worker: '工作者',
  scheduler: '调度器', allocator: '分配器', collector: '收集器', reactor: '反应器', mesh: '网格',
  fabric: '织构', overlay: '覆盖网', beacon: '信标', sentinel: '哨兵', envoy: '使者',
  courier: '信使', relay: '中继', conduit: '管道', harbor: '港湾', vault: '保险库',
}

const F = Object.keys(FEATURES)
const C = Object.keys(COMPONENTS)

// mulberry32 seeded PRNG (Date.now/Math.random avoided for byte-reproducibility)
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pageBody(f, c, value, value2, otherF, otherC) {
  return `The ${f} ${c} subsystem coordinates ${f} operations across the ${c} layer. It exposes a ${f}-oriented interface so downstream services can drive ${c} workloads without managing ${f} state directly. Typical deployments pair the ${f} ${c} with a ${otherF} ${otherC} to balance load and isolate failure domains. The measured ${f} ${c} throughput is ${value} units under nominal conditions, and it sustains ${value2} concurrent ${c} handles before backpressure engages. Operators tune the ${f} ${c} by adjusting the ${c} window and the ${f} batch size.`
}

function main() {
  const args = process.argv.slice(2)
  const opt = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1] }
  const tier = Number.parseInt(opt('--tier', ''), 10)
  if (!Number.isInteger(tier) || tier <= 0) { console.error('--tier <n> is required (e.g. 500, 1000, 2000)'); process.exit(1) }
  const maxPairs = F.length * C.length
  if (tier > maxPairs) { console.error(`--tier ${tier} exceeds ${maxPairs} unique (feature,component) pairs; add more words`); process.exit(1) }
  const out = opt('--out', `scripts/eval/corpus/kb-synth-${tier}`)
  const probesOut = opt('--probes-out', `scripts/eval/probes-synth-${tier}.jsonl`)
  const sample = Number.parseInt(opt('--sample', '60'), 10)
  if (!Number.isInteger(sample) || sample <= 0) { console.error('--sample must be a positive integer'); process.exit(1) }
  const seed = Number.parseInt(opt('--seed', '1'), 10)
  const rnd = mulberry32(seed)

  // Assign the first `tier` unique (f,c) pairs in a fixed order (row-major), so a page's
  // identity is stable across runs and independent of the PRNG (which only fills facts).
  const pages = []
  for (let i = 0; i < tier; i++) {
    const f = F[Math.floor(i / C.length)]
    const c = C[i % C.length]
    const value = 1000 + Math.floor(rnd() * 9000)     // unique-ish throughput fact
    const value2 = 10 + Math.floor(rnd() * 990)
    const otherF = F[Math.floor(rnd() * F.length)]
    const otherC = C[Math.floor(rnd() * C.length)]
    const slug = `syn-${f}-${c}`
    pages.push({ f, c, slug, value, value2, otherF, otherC })
  }

  const wikiDir = path.join(out, 'wiki', 'concepts')
  fs.rmSync(path.join(out, 'wiki'), { recursive: true, force: true })
  fs.mkdirSync(wikiDir, { recursive: true })
  fs.mkdirSync(path.join(out, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(out, 'wiki.config.json'), '{\n  "vectorEnabled": true\n}\n')

  for (const p of pages) {
    const title = `${p.f} ${p.c} subsystem`
    const body = pageBody(p.f, p.c, p.value, p.value2, p.otherF, p.otherC)
    const fm = [
      '---',
      `title: ${JSON.stringify(title)}`,
      'type: concept',
      `tags: [${JSON.stringify(p.f)}, ${JSON.stringify(p.c)}]`,
      `description: ${JSON.stringify(`The ${p.f} ${p.c} subsystem and its throughput characteristics.`)}`,
      'sources: []',
      `created: ${CORPUS_DATE}`,
      `updated: ${CORPUS_DATE}`,
      '---',
    ].join('\n')
    fs.writeFileSync(path.join(wikiDir, `${p.slug}.md`), `${fm}\n\n# ${title}\n\n${body}\n`)
  }

  const r = buildIndex(out)

  // Sample `sample` pages spread evenly across the WHOLE corpus, endpoints INCLUSIVE:
  // j=0 -> page 0, j=sample-1 -> page tier-1, so the last page is always covered (a
  // j*tier/sample map tops out at tier-tier/sample and silently drops the tail).
  // Dedupe indices so sample > tier can't emit duplicate probes for one page.
  const idxs = []
  const seenIdx = new Set()
  for (let j = 0; j < sample; j++) {
    const i = sample === 1 ? 0 : Math.round((j * (tier - 1)) / (sample - 1))
    if (!seenIdx.has(i)) { seenIdx.add(i); idxs.push(i) }
  }
  const probeLines = []
  for (const i of idxs) {
    const p = pages[i]
    const id = `concepts/${p.slug}`
    // fact (en): names the pair in English -> BM25-favorable same-language retrieval.
    probeLines.push(JSON.stringify({
      q: `What is the measured throughput of the ${p.f} ${p.c} subsystem?`,
      expect: [id], lang: 'en', type: 'fact',
    }))
    // xlang (zh): names the pair via Chinese glosses only -> zero English-token overlap.
    probeLines.push(JSON.stringify({
      q: `${FEATURES[p.f]}${COMPONENTS[p.c]}子系统在标准条件下测得的吞吐量是多少？`,
      expect: [id], lang: 'zh-x', type: 'xlang',
    }))
  }
  fs.writeFileSync(probesOut, probeLines.join('\n') + '\n')

  console.log(`synthetic tier ${tier}: ${pages.length} pages → ${out} (indexed ${r.pageCount ?? pages.length})`)
  console.log(`probes: ${probeLines.length} (${probeLines.length / 2} fact-en + ${probeLines.length / 2} xlang-zh) → ${probesOut}`)
  console.log(`next: llm-wiki embed --kb ${out}   then   node scripts/eval/eval.mjs --kb ${out} --probes ${probesOut} --arms bm25,vector,hybrid,auto`)
}

main()
