import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '@kodus/flow';
import { Sandbox } from 'e2b';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';

@Injectable()
export class SandboxLeaseReaperService {
    private readonly logger = createLogger(SandboxLeaseReaperService.name);

    constructor(
        private readonly leaseRepository: SandboxLeaseRepository,
        private readonly distributedLockService: DistributedLockService,
        private readonly configService: ConfigService,
    ) {}

    @Cron(CronExpression.EVERY_5_MINUTES)
    async reapExpiredLeases(): Promise<void> {
        const lock = await this.acquireCronLock(
            'CRON:SANDBOX:LEASE_REAPER',
            4 * 60 * 1000,
        );
        if (!lock) return;

        try {
            const expired = await this.leaseRepository.findExpired(new Date());

            for (const lease of expired) {
                if (lease.sandboxId && lease.state !== 'INVALIDATED') {
                    const apiKey =
                        this.configService.get<string>('API_E2B_KEY');
                    if (apiKey) {
                        await Sandbox.kill(lease.sandboxId, {
                            apiKey,
                        }).catch((err) => {
                            this.logger.warn({
                                message:
                                    '[SANDBOX-REAPER] Failed to kill sandbox — continuing',
                                context: SandboxLeaseReaperService.name,
                                metadata: {
                                    sandboxId: lease.sandboxId,
                                    error: String(err),
                                },
                            });
                        });
                    }
                }

                await this.leaseRepository.delete(lease._id);

                this.logger.log({
                    message: '[SANDBOX-REAPER] Reaped expired lease',
                    context: SandboxLeaseReaperService.name,
                    metadata: {
                        prKey: lease._id,
                        sandboxId: lease.sandboxId,
                        state: lease.state,
                    },
                });
            }
        } finally {
            await this.releaseCronLock(
                lock,
                'Failed to release sandbox lease reaper lock',
            );
        }
    }

    private async acquireCronLock(
        key: string,
        ttl: number,
    ): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(key, { ttl });
        } catch (error) {
            this.logger.error({
                message: `Failed to acquire cron lock: ${key}`,
                context: SandboxLeaseReaperService.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }

    private async releaseCronLock(
        lock: DistributedLock | null,
        errorMessage: string,
    ): Promise<void> {
        if (!lock) return;

        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: errorMessage,
                context: SandboxLeaseReaperService.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
