// Implements REQ-PIPE-004
//
// Curated feed registry for the global-feed scrape pipeline. Each entry is
// a trusted HTTPS feed (RSS, Atom, or JSON Feed) that the scrape coordinator
// fans out across every cron tick.
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
 * least once with room to spare.
 */
export const CURATED_SOURCES: readonly CuratedSource[] = [
  // ---- Cloud vendors -----------------------------------------------------
  {
    slug: 'cloudflare-blog',
    name: 'Cloudflare Blog',
    feed_url: 'https://blog.cloudflare.com/rss/',
    kind: 'rss',
    tags: ['cloudflare'],
  },
  {
    slug: 'cloudflare-workers',
    name: 'Cloudflare Workers',
    feed_url: 'https://blog.cloudflare.com/tag/workers/rss/',
    kind: 'rss',
    tags: ['serverless', 'cloudflare'],
  },
  {
    slug: 'cloudflare-release-notes',
    name: 'Cloudflare Release Notes',
    feed_url: 'https://blog.cloudflare.com/tag/release-notes/rss/',
    kind: 'rss',
    tags: ['cloudflare'],
  },
  {
    slug: 'cloudflare-product-news',
    name: 'Cloudflare Product News',
    feed_url: 'https://blog.cloudflare.com/tag/product-news/rss/',
    kind: 'rss',
    tags: ['cloudflare'],
  },
  {
    slug: 'aws-whats-new',
    name: "AWS What's New",
    feed_url: 'https://aws.amazon.com/new/feed/',
    kind: 'rss',
    tags: ['aws'],
  },
  {
    slug: 'azure-blog',
    name: 'Azure Blog',
    feed_url: 'https://azure.microsoft.com/en-us/blog/feed/',
    kind: 'rss',
    tags: ['azure'],
  },
  {
    slug: 'gcp-blog',
    name: 'Google Cloud Blog',
    feed_url: 'https://cloudblog.withgoogle.com/rss/',
    kind: 'rss',
    tags: ['gcp'],
  },
  {
    slug: 'vercel-blog',
    name: 'Vercel Blog',
    feed_url: 'https://vercel.com/atom',
    kind: 'atom',
    tags: ['serverless'],
  },
  {
    slug: 'flyio-blog',
    name: 'Fly.io Blog',
    feed_url: 'https://fly.io/blog/feed.xml',
    kind: 'rss',
    tags: ['serverless'],
  },

  // ---- AI labs + research ------------------------------------------------
  {
    slug: 'openai-blog',
    name: 'OpenAI Blog',
    feed_url: 'https://openai.com/blog/rss.xml',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'deepmind-blog',
    name: 'Google DeepMind',
    feed_url: 'https://deepmind.google/blog/rss.xml',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'huggingface-blog',
    name: 'Hugging Face Blog',
    feed_url: 'https://huggingface.co/blog/feed.xml',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'google-ai-blog',
    name: 'Google AI Blog',
    feed_url: 'https://blog.google/technology/ai/rss/',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'microsoft-ai-blog',
    name: 'Microsoft AI Blog',
    feed_url: 'https://blogs.microsoft.com/ai/feed/',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'nvidia-blog',
    name: 'Nvidia Blog',
    feed_url: 'https://blogs.nvidia.com/feed/',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'nvidia-dev-blog',
    name: 'NVIDIA Developer Blog',
    feed_url: 'https://developer.nvidia.com/blog/feed',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'paperswithcode',
    name: 'Papers With Code',
    feed_url: 'https://paperswithcode.com/feeds/latest',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'arxiv-cs-ai',
    name: 'arXiv cs.AI',
    feed_url: 'https://rss.arxiv.org/rss/cs.AI',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'berkeley-ai-research',
    name: 'Berkeley AI Research',
    feed_url: 'https://bair.berkeley.edu/blog/feed.xml',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'mit-news-ai',
    name: 'MIT News — AI',
    feed_url: 'https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'the-gradient',
    name: 'The Gradient',
    feed_url: 'https://thegradient.pub/rss/',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'google-news-anthropic',
    name: 'Google News — Anthropic',
    feed_url: 'https://news.google.com/rss/search?q=anthropic+OR+claude+ai&hl=en-US&gl=US&ceid=US:en',
    kind: 'rss',
    tags: ['ai-agents', 'generative-ai'],
  },

  // ---- MCP / agentic / coding-agents ------------------------------------
  {
    slug: 'langchain-blog',
    name: 'LangChain Blog',
    feed_url: 'https://blog.langchain.com/rss/',
    kind: 'rss',
    tags: ['ai-agents', 'generative-ai', 'mcp'],
  },
  {
    slug: 'autogpt-news',
    name: 'AutoGPT News',
    feed_url: 'https://news.agpt.co/rss/',
    kind: 'rss',
    tags: ['ai-agents', 'mcp'],
  },
  {
    slug: 'github-blog',
    name: 'GitHub Blog',
    feed_url: 'https://github.blog/feed/',
    kind: 'rss',
    tags: ['coding-agents', 'devsecops'],
  },
  {
    slug: 'github-copilot-tag',
    name: 'GitHub Copilot Blog',
    feed_url: 'https://github.blog/tag/github-copilot/feed/',
    kind: 'rss',
    tags: ['coding-agents'],
  },
  {
    slug: 'google-news-coding-agents',
    name: 'Google News — AI Coding Agents',
    feed_url: 'https://news.google.com/rss/search?q=%22Cursor+IDE%22+OR+%22GitHub+Copilot%22+OR+%22Claude+Code%22+coding&hl=en-US&gl=US&ceid=US:en',
    kind: 'rss',
    tags: ['coding-agents'],
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
    tags: ['threat-intel', 'devsecops', 'siem', 'appsec'],
  },
  {
    slug: 'gitlab-blog',
    name: 'GitLab Blog',
    feed_url: 'https://about.gitlab.com/atom.xml',
    kind: 'atom',
    tags: ['devsecops', 'zero-trust', 'kubernetes', 'appsec'],
  },
  {
    slug: 'microsoft-security',
    name: 'Microsoft Security',
    feed_url: 'https://www.microsoft.com/security/blog/feed/',
    kind: 'rss',
    tags: ['threat-intel', 'zero-trust', 'azure', 'iam', 'siem'],
  },
  {
    slug: 'cloudflare-security',
    name: 'Cloudflare Security',
    feed_url: 'https://blog.cloudflare.com/tag/security/rss/',
    kind: 'rss',
    tags: ['threat-intel', 'zero-trust', 'cloudflare', 'iam'],
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
    tags: ['threat-intel', 'devsecops', 'appsec'],
  },
  {
    slug: 'snyk-blog',
    name: 'Snyk Blog',
    feed_url: 'https://snyk.io/blog/feed/',
    kind: 'rss',
    tags: ['appsec', 'supply-chain-security', 'devsecops'],
  },
  {
    slug: 'portswigger-blog',
    name: 'PortSwigger Web Security Blog',
    feed_url: 'https://portswigger.net/blog/rss',
    kind: 'rss',
    tags: ['appsec'],
  },
  {
    slug: 'semgrep-blog',
    name: 'Semgrep Blog',
    feed_url: 'https://semgrep.dev/blog/rss.xml',
    kind: 'rss',
    tags: ['appsec'],
  },
  {
    slug: 'trail-of-bits',
    name: 'Trail of Bits Blog',
    feed_url: 'https://blog.trailofbits.com/feed/',
    kind: 'rss',
    tags: ['appsec', 'supply-chain-security'],
  },
  {
    slug: 'auth0-blog',
    name: 'Auth0 Blog',
    feed_url: 'https://auth0.com/blog/rss.xml',
    kind: 'rss',
    tags: ['iam'],
  },
  {
    slug: 'okta-developer',
    name: 'Okta Developer Blog',
    feed_url: 'https://developer.okta.com/feed.xml',
    kind: 'atom',
    tags: ['iam'],
  },
  {
    slug: 'workos-blog',
    name: 'WorkOS Blog',
    feed_url: 'https://workos.com/blog/rss.xml',
    kind: 'rss',
    tags: ['iam'],
  },
  {
    slug: 'cloudflare-cryptography',
    name: 'Cloudflare Cryptography',
    feed_url: 'https://blog.cloudflare.com/tag/cryptography/rss/',
    kind: 'rss',
    tags: ['pqc', 'cloudflare'],
  },
  {
    slug: 'google-news-pqc',
    name: 'Google News — Post-Quantum Cryptography',
    feed_url: 'https://news.google.com/rss/search?q=%22post-quantum+cryptography%22&hl=en-US&gl=US&ceid=US:en',
    kind: 'rss',
    tags: ['pqc'],
  },
  {
    slug: 'sigstore-blog',
    name: 'Sigstore Blog',
    feed_url: 'https://blog.sigstore.dev/index.xml',
    kind: 'rss',
    tags: ['supply-chain-security'],
  },
  {
    slug: 'chainguard-blog',
    name: 'Chainguard Blog',
    feed_url: 'https://www.chainguard.dev/unchained/rss.xml',
    kind: 'rss',
    tags: ['supply-chain-security'],
  },
  {
    slug: 'aquasec-blog',
    name: 'Aqua Security Blog',
    feed_url: 'https://blog.aquasec.com/rss.xml',
    kind: 'rss',
    tags: ['supply-chain-security', 'devsecops'],
  },
  {
    slug: 'elastic-security-labs',
    name: 'Elastic Security Labs',
    feed_url: 'https://www.elastic.co/security-labs/rss/feed.xml',
    kind: 'rss',
    tags: ['siem', 'threat-intel', 'appsec'],
  },
  {
    slug: 'sentinelone-blog',
    name: 'SentinelOne Blog',
    feed_url: 'https://www.sentinelone.com/feed/',
    kind: 'rss',
    tags: ['siem', 'threat-intel'],
  },
  {
    slug: 'security-googleblog',
    name: 'Google Security Blog',
    feed_url: 'https://security.googleblog.com/feeds/posts/default',
    kind: 'atom',
    tags: ['gcp', 'threat-intel'],
  },
  {
    slug: 'google-news-openziti',
    name: 'Google News — OpenZiti & Zero Trust Networking',
    feed_url: 'https://news.google.com/rss/search?q=openziti+OR+%22zero+trust+networking%22&hl=en-US&gl=US&ceid=US:en',
    kind: 'rss',
    tags: ['openziti'],
  },

  // ---- DevOps / platforms ------------------------------------------------
  {
    slug: 'hashicorp-blog',
    name: 'HashiCorp Blog',
    feed_url: 'https://www.hashicorp.com/blog/feed.xml',
    kind: 'rss',
    tags: ['devsecops', 'iam'],
  },
  {
    slug: 'kubernetes-blog',
    name: 'Kubernetes Blog',
    feed_url: 'https://kubernetes.io/feed.xml',
    kind: 'rss',
    tags: ['kubernetes'],
  },
  {
    slug: 'cncf-blog',
    name: 'CNCF Blog',
    feed_url: 'https://www.cncf.io/feed/',
    kind: 'rss',
    tags: ['kubernetes'],
  },
  {
    slug: 'docker-blog',
    name: 'Docker Blog',
    feed_url: 'https://www.docker.com/blog/feed/',
    kind: 'rss',
    tags: ['docker', 'kubernetes', 'devsecops'],
  },
  {
    slug: 'datadog-engineering',
    name: 'Datadog Engineering',
    feed_url: 'https://engineering.datadoghq.com/feed.xml',
    kind: 'rss',
    tags: ['devsecops'],
  },
  {
    slug: 'stripe-blog',
    name: 'Stripe Blog',
    feed_url: 'https://stripe.com/blog/feed.rss',
    kind: 'rss',
    tags: ['devsecops'],
  },
  {
    slug: 'slack-engineering',
    name: 'Slack Engineering',
    feed_url: 'https://slack.engineering/feed',
    kind: 'rss',
    tags: ['devsecops'],
  },

  // ---- Community aggregators --------------------------------------------
  {
    slug: 'hn-frontpage',
    name: 'Hacker News',
    feed_url: 'https://hnrss.org/frontpage',
    kind: 'rss',
    tags: ['ai-agents', 'generative-ai', 'cloudflare'],
  },
  {
    slug: 'lobsters',
    name: 'Lobsters',
    feed_url: 'https://lobste.rs/rss',
    kind: 'rss',
    tags: ['devsecops', 'kubernetes'],
  },
  {
    slug: 'the-register',
    name: 'The Register',
    feed_url: 'https://www.theregister.com/headlines.atom',
    kind: 'atom',
    tags: ['threat-intel'],
  },
  {
    slug: 'arstechnica',
    name: 'Ars Technica',
    feed_url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',
    kind: 'rss',
    tags: ['generative-ai'],
  },
  {
    slug: 'techcrunch',
    name: 'TechCrunch',
    feed_url: 'https://techcrunch.com/feed/',
    kind: 'rss',
    tags: ['generative-ai', 'ai-agents'],
  },
  {
    slug: 'infoq',
    name: 'InfoQ',
    feed_url: 'https://feed.infoq.com/',
    kind: 'rss',
    tags: ['kubernetes', 'devsecops'],
  },
] as const;
