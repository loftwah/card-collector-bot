// Dedicated candidate entrypoint. Building this source alone does not produce
// an approved rollback artifact: deploy bindings and built-Worker routing need
// separate verification against the exact production baseline.
import worker, { PluginBridge } from './worker';
import { withDiscordQuarantine } from './server/discord/quarantine';

export { PluginBridge };
export default withDiscordQuarantine(worker);
