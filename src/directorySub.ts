// Board §04: the least needed to tell same-named people apart, from what auth
// already returns (never guessed from the name): joined rows show the real
// @username (resolved; never portal_<uuid>), else "Enterprise" when resolve
// says so; then the UID and the masked phone. Portal-only rows: enterprise,
// the masked phone when there is one, then not joined.
import type { DirectoryEntry } from "./api.ts";
import { handleFor, isEnterprise } from "./names.ts";

export function directorySub(entry: DirectoryEntry, t: (key: string) => string): string {
  if (!entry.provisioned) return [t("badge.enterprise"), entry.phoneMasked, t("badge.notJoined")].filter(Boolean).join(" · ");
  const uid = String(entry.id);
  const handle = handleFor(uid, entry.username);
  const lead = handle ? `@${handle}` : isEnterprise(uid) ? t("badge.enterprise") : "";
  return [lead, `${t("badge.uid")} ${uid}`, entry.phoneMasked].filter(Boolean).join(" · ");
}
