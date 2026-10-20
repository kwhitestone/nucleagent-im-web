// From core-web src/bootstrap.ts: the shell's host:init and the agentia host's embed-init.
/** Keep only public init metadata while configuration and the app load. */
export async function startRuntimeApp(
  loadConfig: () => Promise<void>,
  mountApp: () => Promise<void>,
  target: Window,
): Promise<void> {
  const initial = new Map<string, MessageEvent>();
  const capture = (event: MessageEvent) => {
    if (event.source !== target.parent || target.parent === target) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    let safe: object;
    if (data.type === "host:init" && data.protocol === "prism-fusion/remote" &&
        data.version === 1 && data.appId === "im" &&
        typeof data.instanceId === "string" && /^[a-zA-Z0-9-]{16,128}$/.test(data.instanceId)) {
      safe = { type: data.type, protocol: data.protocol, version: 1, appId: "im", instanceId: data.instanceId };
    } else if (data.type === "agentia:embed-init" && typeof data.payload?.conversationId === "string" &&
        data.payload.conversationId.length <= 200) {
      safe = { type: data.type, payload: { conversationId: data.payload.conversationId } };
    } else return;
    // Listeners installed during mount must not also consume the buffered init.
    event.stopImmediatePropagation();
    initial.set(data.type, new MessageEvent("message", { data: safe, origin: event.origin, source: event.source }));
  };
  target.addEventListener("message", capture, { capture: true });
  try {
    await loadConfig();
    await mountApp();
  } catch (error) {
    initial.clear();
    throw error;
  } finally {
    target.removeEventListener("message", capture, { capture: true });
  }
  // The original listeners still validate origin, source, protocol and instance.
  for (const event of initial.values()) target.dispatchEvent(event);
}
