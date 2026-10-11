// From core-web src/bootstrap.ts, narrowed to im-web's only init message.
/** Keep only public init metadata while configuration and the app load. */
export async function startRuntimeApp(
  loadConfig: () => Promise<void>,
  mountApp: () => Promise<void>,
  target: Window,
): Promise<void> {
  let initial: MessageEvent | undefined;
  const capture = (event: MessageEvent) => {
    if (event.source !== target.parent || target.parent === target) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (!(data.type === "host:init" && data.protocol === "prism-fusion/remote" &&
        data.version === 1 && data.appId === "im" &&
        typeof data.instanceId === "string" && /^[a-zA-Z0-9-]{16,128}$/.test(data.instanceId))) return;
    const safe = { type: data.type, protocol: data.protocol, version: 1, appId: "im", instanceId: data.instanceId };
    // Listeners installed during mount must not also consume the buffered init.
    event.stopImmediatePropagation();
    initial = new MessageEvent("message", { data: safe, origin: event.origin, source: event.source });
  };
  target.addEventListener("message", capture, { capture: true });
  try {
    await loadConfig();
    await mountApp();
  } catch (error) {
    initial = undefined;
    throw error;
  } finally {
    target.removeEventListener("message", capture, { capture: true });
  }
  // The original listeners still validate origin, source, protocol and instance.
  if (initial) target.dispatchEvent(initial);
}
