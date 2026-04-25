// Implements REQ-PIPE-004
//
// Curated feed registry for the global-feed scrape pipeline. Each entry is
// a trusted HTTPS feed (RSS, Atom, or JSON Feed) that the hourly coordinator
// will fan out across every :00 tick.
//
// Invariants enforced by `tests/pipeline/curated-sources.test.ts`:
//   - ≥50 entries total
//   - every DEFAULT_HASHTAGS slug appears in ≥1 source's `tags`
//   - every source has ≥1 tag
//   - every `feed_url` starts with `https://`
//   - every `kind` is one of `rss | atom | json`
//   - every `slug` is unique
//
// Live-fetch validation is deliberately NOT automated — the dev script
// `scripts/validate-curated-sources.mjs` probes each URL with a real fetch
// and prints a swap-list for feeds that 4xx/5xx. Run it before every deploy.

/** Feed format. We parse RSS 2.0 and Atom the same way (fast-xml-parser);
 * `json` is reserved for JSON Feed 1.1 endpoints. */
export type CuratedSourceKind = 'rss' | 'atom' | 'json';

/** A single curated feed entry. */
export interface CuratedSource {
  /** Stable unique id — lowercase-kebab, shown in logs + cache keys. */
  slug: string;
  /** Human label shown in UI badges and alt-source lists. */
  name: string;
  /** Fully qualified HTTPS feed URL. */
  feed_url: string;
  /** Which parser shape to use. */
  kind: CuratedSourceKind;
  /** One or more tag slugs from the 20-tag default registry. ≥1 required. */
  tags: string[];
}

/**
 * The canonical source registry. Mutating this array is the only way to
 * add/remove/retune feeds — there is no runtime registration path.
 *
 * Grouping below mirrors the implementation plan; ordering is not
 * observable from outside. Composition covers every default hashtag at
 * least once with room to spare, and gives the chunked LLM pipeline a
 * ~300-article input pool per hour after per-feed item caps.
 */
export const CURATED_SOURCES: readonly CuratedSource[] = [
  // ---- Cloud vendors -----------------------------------------------------
  {
    slug: 'cloudflare-blog',
    name: 'Cloudflare Blog',
    feed_url: 'https://blog.cloudflare.com/rss/',
    kind: 'rss',
    tags: ['cloudflare', 'cloud'],
  },
  {
    slug: 'cloudflare-workers',
    name: 'Cloudflare Workers',
    feed_url: 'https://blog.cloudflare.com/tag/workers/rss/',
    kind: 'rss',
    tags: ['workers', 'serverless', 'cloudflare'],
  },
  {
    slug: 'aws-whats-new',
    name: "AWS What's New",
    feed_url: 'https://aws.amazon.com/new/feed/',
    kind: 'rss',
    tags: ['aws', 'cloud'],
  },
  {
    slug: 'azure-blog',
    name: 'Azure Blog',
    feed_url: 'https://azure.microsoft.com/blog/feed/',
    kind: 'rss',
    tags: ['azure', 'cloud'],
  },
  {
    slug: 'gcp-blog',
    name: 'Google Cloud Blog',
    feed_url: 'https://cloudblog.withgoogle.com/rss/',
    kind: 'rss',
    tags: ['cloud'],
  },
  {
    slug: 'vercel-blog',
    name: 'Vercel Blog',
    feed_url: 'https://vercel.com/atom',
    kind: 'atom',
    tags: ['cloud', 'serverless'],
  },
  {
    slug: 'flyio-blog',
    name: 'Fly.io Blog',
    feed_url: 'https://fly.io/blog/feed.xml',
    kind: 'rss',
    tags: ['cloud', 'serverless'],
  },
  {
    slug: 'cloudflare-release-notes',
    name: 'Cloudflare Release Notes',
    feed_url: 'https://blog.cloudflare.com/tag/release-notes/rss/',
    kind: 'rss',
    tags: ['cloudflare', 'workers', 'cloud'],
  },
  {
    slug: 'cloudflare-product-news',
    name: 'Cloudflare Product News',
    feed_url: 'https://blog.cloudflare.com/tag/product-news/rss/',
    kind: 'rss',
    tags: ['cloudflare', 'workers', 'cloud'],
  },
  {
    slug: 'railway-blog',
    name: 'Railway Blog',
    feed_url: 'https://blog.railway.com/feed.xml',
    kind: 'rss',
    tags: ['cloud'],
  },

  // ---- AI labs + research ------------------------------------------------
  {
    slug: 'nvidia-dev-blog',
    name: 'NVIDIA Developer Blog',
    feed_url: 'https://developer.nvidia.com/blog/feed',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    slug: 'openai-blog',
    name: 'OpenAI Blog',
    feed_url: 'https://openai.com/blog/rss.xml',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    slug: 'deepmind-blog',
    name: 'Google DeepMind',
    feed_url: 'https://deepmind.google/blog/rss.xml',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    slug: 'github-blog',
    name: 'GitHub Blog',
    feed_url: 'https://github.blog/feed/',
    kind: 'rss',
    tags: ['ai', 'devsecops', 'cloud'],
  },
  {
    slug: 'huggingface-blog',
    name: 'Hugging Face Blog',
    feed_url: 'https://huggingface.co/blog/feed.xml',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    slug: 'paperswithcode',
    name: 'Papers With Code',
    feed_url: 'https://paperswithcode.com/feeds/latest',
    kind: 'rss',
    tags: ['ai'],
  },
  {
    slug: 'arxiv-cs-ai',
    name: 'arXiv cs.AI',
    feed_url: 'https://rss.arxiv.org/rss/cs.AI',
    kind: 'rss',
    tags: ['ai'],
  },
  {
    // Google's official AI blog at blog.google. Distinct from
    // deepmind-blog above, which is the research-org subsite.
    slug: 'google-ai-blog',
    name: 'Google AI Blog',
    feed_url: 'https://blog.google/technology/ai/rss/',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    slug: 'microsoft-ai-blog',
    name: 'Microsoft AI Blog',
    feed_url: 'https://blogs.microsoft.com/ai/feed/',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    // Corporate Nvidia blog. Distinct from nvidia-dev-blog above,
    // which is the developer.nvidia.com subdomain (CUDA/Jetson/etc.).
    slug: 'nvidia-blog',
    name: 'Nvidia Blog',
    feed_url: 'https://blogs.nvidia.com/feed/',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    slug: 'berkeley-ai-research',
    name: 'Berkeley AI Research',
    feed_url: 'https://bair.berkeley.edu/blog/feed.xml',
    kind: 'rss',
    tags: ['ai'],
  },
  {
    slug: 'mit-news-ai',
    name: 'MIT News — AI',
    feed_url: 'https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml',
    kind: 'rss',
    tags: ['ai'],
  },
  {
    // Independent editorial AI publication; longer-form than the
    // vendor blogs and tends to land critical perspectives.
    slug: 'the-gradient',
    name: 'The Gradient',
    feed_url: 'https://thegradient.pub/rss/',
    kind: 'rss',
    tags: ['ai'],
  },
  {
    // Anthropic exposes no public RSS at any standard path (probed
    // /rss, /feed, /news/rss, /research/rss, /index.xml, etc. — all
    // 404). Fall back to a Google News query for Claude/Anthropic
    // coverage from third-party publishers. The same Google News
    // query-RSS pattern that REQ-DISC-001 already uses for
    // discovery-fallback on consumer/brand tags.
    slug: 'google-news-anthropic',
    name: 'Google News — Anthropic',
    feed_url: 'https://news.google.com/rss/search?q=anthropic+OR+claude+ai&hl=en-US&gl=US&ceid=US:en',
    kind: 'rss',
    tags: ['ai', 'genai'],
  },
  {
    slug: 'stripe-blog',
    name: 'Stripe Blog',
    feed_url: 'https://stripe.com/blog/feed.rss',
    kind: 'rss',
    tags: ['cloud', 'devsecops'],
  },

  // ---- MCP / agentic -----------------------------------------------------
  {
    slug: 'docker-blog',
    name: 'Docker Blog',
    feed_url: 'https://www.docker.com/blog/feed/',
    kind: 'rss',
    tags: ['devsecops', 'kubernetes', 'cloud'],
  },
  {
    slug: 'spotify-engineering',
    name: 'Spotify Engineering',
    feed_url: 'https://engineering.atspotify.com/feed',
    kind: 'rss',
    tags: ['observability', 'cloud'],
  },
  {
    slug: 'langchain-blog',
    name: 'LangChain Blog',
    feed_url: 'https://blog.langchain.com/rss/',
    kind: 'rss',
    tags: ['ai', 'agenticai', 'genai', 'mcp'],
  },
  {
    slug: 'autogpt-news',
    name: 'AutoGPT News',
    feed_url: 'https://news.agpt.co/rss/',
    kind: 'rss',
    tags: ['ai', 'agenticai', 'mcp'],
  },

  // ---- Security ----------------------------------------------------------
  {
    slug: 'unit42',
    name: 'Unit 42',
    feed_url: 'https://unit42.paloaltonetworks.com/feed/',
    kind: 'rss',
    tags: ['threat-intel'],
  },
  {
    slug: 'crowdstrike-blog',
    name: 'CrowdStrike Blog',
    feed_url: 'https://www.crowdstrike.com/en-us/blog/feed',
    kind: 'rss',
    tags: ['threat-intel', 'devsecops'],
  },
  {
    slug: 'gitlab-blog',
    name: 'GitLab Blog',
    feed_url: 'https://about.gitlab.com/atom.xml',
    kind: 'atom',
    tags: ['devsecops', 'zero-trust', 'kubernetes'],
  },
  {
    slug: 'bunny-blog',
    name: 'Bunny.net Blog',
    feed_url: 'https://bunny.net/blog/rss/',
    kind: 'rss',
    tags: ['cloud', 'microsegmentation'],
  },
  {
    slug: 'microsoft-security',
    name: 'Microsoft Security',
    feed_url: 'https://www.microsoft.com/security/blog/feed/',
    kind: 'rss',
    tags: ['threat-intel', 'zero-trust', 'azure'],
  },
  {
    slug: 'cloudflare-security',
    name: 'Cloudflare Security',
    feed_url: 'https://blog.cloudflare.com/tag/security/rss/',
    kind: 'rss',
    tags: ['threat-intel', 'zero-trust', 'cloudflare'],
  },
  {
    slug: 'cisco-talos',
    name: 'Cisco Talos',
    feed_url: 'https://blog.talosintelligence.com/rss/',
    kind: 'rss',
    tags: ['threat-intel'],
  },
  {
    slug: 'hacker-news-sec',
    name: 'The Hacker News',
    feed_url: 'https://feeds.feedburner.com/TheHackersNews',
    kind: 'rss',
    tags: ['threat-intel', 'devsecops'],
  },

  // ---- DevOps / platforms ------------------------------------------------
  {
    slug: 'hashicorp-blog',
    name: 'HashiCorp Blog',
    feed_url: 'https://www.hashicorp.com/blog/feed.xml',
    kind: 'rss',
    tags: ['terraform', 'devsecops'],
  },
  {
    slug: 'kubernetes-blog',
    name: 'Kubernetes Blog',
    feed_url: 'https://kubernetes.io/feed.xml',
    kind: 'rss',
    tags: ['kubernetes', 'cloud'],
  },
  {
    slug: 'cncf-blog',
    name: 'CNCF Blog',
    feed_url: 'https://www.cncf.io/feed/',
    kind: 'rss',
    tags: ['kubernetes', 'cloud'],
  },
  {
    slug: 'grafana-blog',
    name: 'Grafana Blog',
    feed_url: 'https://grafana.com/blog/index.xml',
    kind: 'rss',
    tags: ['observability'],
  },
  {
    slug: 'datadog-engineering',
    name: 'Datadog Engineering',
    feed_url: 'https://engineering.datadoghq.com/feed.xml',
    kind: 'rss',
    tags: ['observability', 'devsecops'],
  },
  {
    slug: 'terraform-registry',
    name: 'Terraform Registry',
    feed_url: 'https://registry.terraform.io/feed.xml',
    kind: 'rss',
    tags: ['terraform'],
  },

  // ---- Languages ---------------------------------------------------------
  {
    slug: 'rust-blog',
    name: 'Rust Blog',
    feed_url: 'https://blog.rust-lang.org/feed.xml',
    kind: 'rss',
    tags: ['rust'],
  },
  {
    slug: 'python-insider',
    name: 'Python Insider',
    feed_url: 'https://blog.python.org/feeds/posts/default',
    kind: 'atom',
    tags: ['python'],
  },
  {
    slug: 'go-blog',
    name: 'Go Blog',
    feed_url: 'https://go.dev/blog/feed.atom',
    kind: 'atom',
    tags: ['cloud'],
  },
  {
    slug: 'typescript-blog',
    name: 'TypeScript Blog',
    feed_url: 'https://devblogs.microsoft.com/typescript/feed/',
    kind: 'rss',
    tags: ['cloud'],
  },

  // ---- Community aggregators --------------------------------------------
  {
    slug: 'hn-frontpage',
    name: 'Hacker News',
    feed_url: 'https://hnrss.org/frontpage',
    kind: 'rss',
    tags: ['ai', 'cloud'],
  },
  {
    slug: 'lobsters',
    name: 'Lobsters',
    feed_url: 'https://lobste.rs/rss',
    kind: 'rss',
    tags: ['cloud', 'rust'],
  },
  {
    slug: 'the-register',
    name: 'The Register',
    feed_url: 'https://www.theregister.com/headlines.atom',
    kind: 'atom',
    tags: ['cloud', 'threat-intel'],
  },
  {
    slug: 'arstechnica',
    name: 'Ars Technica',
    feed_url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',
    kind: 'rss',
    tags: ['cloud', 'ai'],
  },
  {
    slug: 'techcrunch',
    name: 'TechCrunch',
    feed_url: 'https://techcrunch.com/feed/',
    kind: 'rss',
    tags: ['ai', 'cloud'],
  },
  {
    slug: 'infoq',
    name: 'InfoQ',
    feed_url: 'https://feed.infoq.com/',
    kind: 'rss',
    tags: ['cloud', 'kubernetes'],
  },

  // ---- Databases ---------------------------------------------------------
  {
    slug: 'postgres-news',
    name: 'PostgreSQL News',
    feed_url: 'https://www.postgresql.org/news.rss',
    kind: 'rss',
    tags: ['postgres'],
  },
  {
    slug: 'supabase-blog',
    name: 'Supabase Blog',
    feed_url: 'https://supabase.com/rss.xml',
    kind: 'rss',
    tags: ['postgres', 'cloud'],
  },
  {
    slug: 'neon-blog',
    name: 'Neon Blog',
    feed_url: 'https://neon.com/blog/rss.xml',
    kind: 'rss',
    tags: ['postgres', 'serverless'],
  },
  {
    slug: 'mongodb-blog',
    name: 'MongoDB Blog',
    feed_url: 'https://www.mongodb.com/blog/rss',
    kind: 'rss',
    tags: ['postgres', 'cloud'],
  },
  {
    slug: 'redis-blog',
    name: 'Redis Blog',
    feed_url: 'https://redis.io/blog/feed/',
    kind: 'rss',
    tags: ['postgres', 'cloud'],
  },

  // ---- Observability / SRE ----------------------------------------------
  {
    slug: 'sre-weekly',
    name: 'SRE Weekly',
    feed_url: 'https://sreweekly.com/feed/',
    kind: 'rss',
    tags: ['observability'],
  },
  {
    slug: 'scylladb-blog',
    name: 'ScyllaDB Blog',
    feed_url: 'https://scylladb.com/feed/',
    kind: 'rss',
    tags: ['postgres', 'observability'],
  },
  {
    slug: 'slack-engineering',
    name: 'Slack Engineering',
    feed_url: 'https://slack.engineering/feed',
    kind: 'rss',
    tags: ['observability', 'devsecops'],
  },
] as const;
