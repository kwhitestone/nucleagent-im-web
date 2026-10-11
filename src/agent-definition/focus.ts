export function trapDialogFocus(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget as HTMLDialogElement;
  const controls = [...dialog.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex='0']",
  )].filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1);
  const active = dialog.ownerDocument.activeElement;
  const target = event.shiftKey && active === first ? last : !event.shiftKey && active === last ? first : undefined;
  if (target) { event.preventDefault(); target.focus(); }
}
