import { DigitalOceanProvider } from './digitalocean.js';
import { HetznerProvider } from './hetzner.js';
import type { VmProvider } from './types.js';

const providers: Record<string, () => VmProvider> = {
    digitalocean: () => new DigitalOceanProvider(),
    hetzner: () => new HetznerProvider(),
    // Extension point — same seam as provision.sh's provider case statement:
    // aws: () => new AwsProvider(),
    // gcp: () => new GcpProvider(),
};

export function getProvider(kind = 'digitalocean'): VmProvider {
    const factory = providers[kind];
    if (!factory) {
        throw new Error(
            `Unknown VM provider '${kind}'. Available: ${Object.keys(providers).join(', ')}`,
        );
    }
    return factory();
}
