import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";

export const hostedAmendmentMarker = "<!-- portcove-hosted-intake-amendment:v1 -->";
export interface HostedAmendment {
  schema_version: 1;
  request_comment: number;
  request_sha256: string;
  receipt_comment: number;
  receipt_sha256: string;
  candidate_index: number;
  port_key: string;
  previous_body_sha256: string;
  previous_evidence_sha256: string | null;
  replacement: { upstream: string; evidence: string; resume: string };
  reason: string;
  hold?: true;
}
export interface AmendmentComment {
  id: number;
  body: string;
  user: { login: string };
  issue_url?: string;
}
export interface AmendmentReference {
  comment: number;
  sha256: string;
}

export function parseHostedAmendment(body: unknown): HostedAmendment {
  if (typeof body !== "string" || Buffer.byteLength(body) > 24000)
    throw new Error("Invalid amendment envelope");
  const match = /^<!-- portcove-hosted-intake-amendment:v1 -->\s*```json\n([\s\S]+)\n```\s*$/u.exec(
    body,
  );
  const value: unknown = match ? JSON.parse(match[1]!) : null;
  if (
    !isRecord(value) ||
    Object.keys(value)
      .filter((key) => key !== "hold")
      .sort()
      .join("|") !==
      [
        "schema_version",
        "request_comment",
        "request_sha256",
        "receipt_comment",
        "receipt_sha256",
        "candidate_index",
        "port_key",
        "previous_body_sha256",
        "previous_evidence_sha256",
        "replacement",
        "reason",
      ]
        .sort()
        .join("|") ||
    value.schema_version !== 1 ||
    (value.hold !== undefined && value.hold !== true) ||
    ![value.request_comment, value.receipt_comment].every(
      (id) => Number.isSafeInteger(id) && Number(id) > 0,
    ) ||
    !Number.isSafeInteger(value.candidate_index) ||
    Number(value.candidate_index) < 0 ||
    ![value.request_sha256, value.receipt_sha256, value.previous_body_sha256].every(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
    ) ||
    !(
      value.previous_evidence_sha256 === null ||
      (typeof value.previous_evidence_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.previous_evidence_sha256))
    ) ||
    typeof value.port_key !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.port_key) ||
    !isRecord(value.replacement) ||
    Object.keys(value.replacement).sort().join("|") !== "evidence|resume|upstream" ||
    typeof value.replacement.upstream !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
      value.replacement.upstream,
    ) ||
    ![value.replacement.evidence, value.replacement.resume, value.reason].every(
      (text) =>
        typeof text === "string" &&
        text.trim() &&
        !text.includes("<!--") &&
        Buffer.byteLength(text) <= 16000,
    )
  )
    throw new Error("Invalid candidate amendment fields");
  return value as unknown as HostedAmendment;
}

export function readHostedAmendment(
  comment: AmendmentComment,
  owner: string,
  repository: string,
  request: { id: number; body: string },
): HostedAmendment {
  if (
    comment.user.login !== owner ||
    comment.issue_url !== `https://api.github.com/repos/${repository}/issues/177` ||
    comment.id <= request.id
  )
    throw new Error("Untrusted candidate amendment");
  const value = parseHostedAmendment(comment.body);
  if (
    value.request_comment !== request.id ||
    value.request_sha256 !== observationHash(request.body) ||
    value.receipt_comment <= request.id ||
    value.receipt_comment >= comment.id
  )
    throw new Error("Candidate amendment source differs");
  return value;
}
