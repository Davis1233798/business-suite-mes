import { dispatchMesProjections } from "./mes-projection";

export async function dispatchInfrastructureOutbox() {
  const result = await dispatchMesProjections();
  return { configured: result.configured, sent: 0, mesSynced: result.sent };
}
