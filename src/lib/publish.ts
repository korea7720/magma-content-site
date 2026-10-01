import fs from "fs";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { COLLECTIONS, Collection, contentHref } from "@/lib/content";

export class PublishError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `publish error ${status}`);
  }
}

export interface PublishResult {
  collection: Collection;
  slug: string;
  url: string;
  mode: "github" | "local";
  commitUrl?: string;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LIMITS = {
  title: 160,
  description: 500,
  content: 100_000,
  tags: 20,
  tag: 50,
  slug: 80,
  url: 2_048,
  period: 32,
} as const;
const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

/** Authorization 헤더 검증 — timing-safe 비교 (길이 일치 시 상수시간) */
export function verifyApiKey(header: string | null): boolean {
  const expected = process.env.PUBLISH_API_KEY;
  if (!expected) return false;
  const provided = header?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function publishPost(input: unknown): Promise<PublishResult> {
  const p = validate(input);
  const slug = makeSlug(p.title, p.slug);
  const date = p.date ?? kstToday();
  const md = buildMarkdown({ ...p, date });

  if (process.env.NODE_ENV === "development") {
    writeLocal(p.collection, slug, md);
    return { collection: p.collection, slug, url: contentHref(p.collection, slug), mode: "local" };
  }
  const hasGitHub = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
  if (hasGitHub) {
    const commitUrl = await commitToGitHub(p.collection, slug, md);
    return { collection: p.collection, slug, url: contentHref(p.collection, slug), mode: "github", commitUrl };
  }
  throw new PublishError(500, {
    error: "GITHUB_TOKEN·GITHUB_REPO 미설정 — Vercel 환경변수를 확인하세요 (.env.example 참고)",
  });
}

interface ValidInput {
  collection: Collection;
  title: string;
  description: string;
  content: string;
  tags: string[];
  slug?: string;
  date?: string;
  thumbnail?: string;
  period?: string;
  dashboardUrl?: string;
  draft: boolean;
}

function validate(input: unknown): ValidInput {
  const b = (input ?? {}) as Record<string, unknown>;
  // collection 은 400(별도) — 잘못된 대상이면 필드 검증 이전에 막는다
  const collection = b.collection === undefined ? "posts" : b.collection;
  if (typeof collection !== "string" || !COLLECTIONS.includes(collection as Collection))
    throw new PublishError(400, { error: `collection 은 ${COLLECTIONS.join(" 또는 ")} 여야 합니다` });

  const errors: Record<string, string> = {};
  if (typeof b.title !== "string" || !b.title.trim()) errors.title = "필수 — 비어 있지 않은 문자열";
  else if (b.title.trim().length > LIMITS.title) errors.title = `최대 ${LIMITS.title}자`;
  if (typeof b.description !== "string" || !b.description.trim()) errors.description = "필수 — 비어 있지 않은 문자열";
  else if (b.description.trim().length > LIMITS.description) errors.description = `최대 ${LIMITS.description}자`;
  if (typeof b.content !== "string" || !b.content.trim()) errors.content = "필수 — 마크다운 본문";
  else if (b.content.length > LIMITS.content) errors.content = `최대 ${LIMITS.content}자`;
  if (b.slug !== undefined && (typeof b.slug !== "string" || b.slug.length > LIMITS.slug || !SLUG_RE.test(b.slug)))
    errors.slug = `ASCII 소문자·숫자·하이픈만, 최대 ${LIMITS.slug}자 (예: my-first-post)`;
  if (b.date !== undefined && (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)))
    errors.date = "YYYY-MM-DD 형식";
  if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.length > LIMITS.tags || b.tags.some((t) => typeof t !== "string" || t.length > LIMITS.tag)))
    errors.tags = `최대 ${LIMITS.tags}개, 각 태그 최대 ${LIMITS.tag}자의 문자열 배열`;
  if (b.thumbnail !== undefined && (typeof b.thumbnail !== "string" || b.thumbnail.length > LIMITS.url || !isAssetPath(b.thumbnail)))
    errors.thumbnail = `사이트 내부 경로 또는 http(s) URL, 최대 ${LIMITS.url}자`;
  if (b.period !== undefined && (typeof b.period !== "string" || b.period.length > LIMITS.period)) errors.period = `문자열, 최대 ${LIMITS.period}자 (예: 2026-Q2)`;
  if (b.dashboardUrl !== undefined && (typeof b.dashboardUrl !== "string" || b.dashboardUrl.length > LIMITS.url || !isDashboardUrl(b.dashboardUrl)))
    errors.dashboardUrl = `http(s) URL 또는 로컬 개발 URL, 최대 ${LIMITS.url}자`;
  if (b.draft !== undefined && typeof b.draft !== "boolean") errors.draft = "true 또는 false";
  if (Object.keys(errors).length > 0) throw new PublishError(422, { error: "검증 실패", fields: errors });

  return {
    collection: collection as Collection,
    title: (b.title as string).trim(),
    description: (b.description as string).trim(),
    content: b.content as string,
    tags: (b.tags as string[] | undefined) ?? [],
    slug: b.slug as string | undefined,
    date: b.date as string | undefined,
    thumbnail: b.thumbnail as string | undefined,
    period: b.period as string | undefined,
    dashboardUrl: b.dashboardUrl as string | undefined,
    draft: b.draft === true,
  };
}

function makeSlug(title: string, explicit?: string): string {
  if (explicit) return explicit;
  const hadNonAscii = /[^\x00-\x7f]/.test(title);
  const ascii = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  if (!hadNonAscii && SLUG_RE.test(ascii) && ascii.length >= 3) return ascii;
  const { compact, hhmmss } = kstParts();
  return `post-${compact}-${hhmmss}-${randomBytes(2).toString("hex")}`;
}

function kstParts() {
  const iso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return {
    date: iso.slice(0, 10),
    compact: iso.slice(0, 10).replaceAll("-", ""),
    hhmmss: iso.slice(11, 19).replaceAll(":", ""),
  };
}

function kstToday(): string {
  return kstParts().date;
}

/** frontmatter 조립 — 값은 JSON.stringify 로 감싸 YAML 특수문자를 안전 처리. period 는 reports 에서만 넣는다. */
function buildMarkdown(p: Omit<ValidInput, "slug" | "date"> & { date: string }): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(p.title)}`,
    `description: ${JSON.stringify(p.description)}`,
    `date: ${p.date}`,
    p.tags.length > 0 ? `tags: [${p.tags.map((t) => JSON.stringify(t)).join(", ")}]` : null,
    p.thumbnail ? `thumbnail: ${JSON.stringify(p.thumbnail)}` : null,
    p.period ? `period: ${JSON.stringify(p.period)}` : null,
    p.dashboardUrl ? `dashboardUrl: ${JSON.stringify(p.dashboardUrl)}` : null,
    p.draft ? "draft: true" : null,
    "---",
    "",
    p.content.trim(),
    "",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

function isAssetPath(value: string): boolean {
  if (value.startsWith("/")) return !value.includes("..");
  return isDashboardUrl(value);
}

function isDashboardUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function commitToGitHub(collection: Collection, slug: string, md: string): Promise<string | undefined> {
  const repoFull = process.env.GITHUB_REPO as string;
  const url = `https://api.github.com/repos/${repoFull}/contents/content/${collection}/${slug}.md`;
  const signal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let head: Response;
  try {
    head = await fetch(url, { headers, cache: "no-store", signal });
  } catch {
    throw new PublishError(502, { error: "GitHub 조회 실패 또는 8초 시간 초과" });
  }
  if (head.status === 200)
    throw new PublishError(409, { error: `slug 중복 — content/${collection}/${slug}.md 가 이미 있습니다`, slug });
  if (head.status !== 404)
    throw new PublishError(502, { error: `GitHub 조회 실패 (HTTP ${head.status}) — GITHUB_TOKEN 권한·GITHUB_REPO 값을 확인하세요` });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers,
      signal,
      body: JSON.stringify({
        message: `${collection}: ${slug} 발행 (publish API)`,
        content: Buffer.from(md, "utf8").toString("base64"),
      }),
    });
  } catch {
    throw new PublishError(502, { error: "GitHub 커밋 요청 실패 또는 8초 시간 초과" });
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new PublishError(502, { error: `GitHub 커밋 실패 (HTTP ${res.status})`, detail });
  }
  const json = (await res.json()) as { commit?: { html_url?: string } };
  return json.commit?.html_url;
}

function writeLocal(collection: Collection, slug: string, md: string): void {
  const dir = path.join(process.cwd(), "content", collection);
  const filePath = path.join(dir, `${slug}.md`);
  if (fs.existsSync(filePath))
    throw new PublishError(409, { error: `slug 중복 — content/${collection}/${slug}.md 가 이미 있습니다`, slug });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, md, "utf8");
}
