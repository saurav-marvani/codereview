import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface DistributedLockOptions {
    ttl?: number; // Time to live in ms (optional, for auto-release)
}

export class DistributedLock {
    private released = false;

    constructor(
        private readonly dataSource: DataSource,
        private readonly lockId: [number, number],
        private readonly ttl?: number,
        private readonly logger = createLogger(DistributedLock.name),
    ) {
        if (ttl) {
            // Auto-release after TTL
            setTimeout(() => {
                if (!this.released) {
                    this.release().catch((error) => {
                        this.logger.error({
                            message: 'Error auto-releasing lock',
                            context: DistributedLock.name,
                            error: error instanceof Error ? error : undefined,
                            metadata: { lockId },
                        });
                    });
                }
            }, ttl);
        }
    }

    async release(): Promise<void> {
        if (this.released) {
            return; // Already released
        }

        try {
            await this.dataSource.query(
                `SELECT pg_advisory_unlock($1, $2)`,
                this.lockId,
            );
            this.released = true;
            this.logger.debug({
                message: 'Distributed lock released',
                context: DistributedLock.name,
                metadata: { lockId: this.lockId },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error releasing distributed lock',
                context: DistributedLock.name,
                error: error instanceof Error ? error : undefined,
                metadata: { lockId: this.lockId },
            });
            throw error;
        }
    }

    isReleased(): boolean {
        return this.released;
    }
}

@Injectable()
export class DistributedLockService {
    private readonly logger = createLogger(DistributedLockService.name);

    constructor(private readonly dataSource: DataSource) {}

    /**
     * Acquire distributed lock using PostgreSQL Advisory Lock
     * @param key - Unique lock key (e.g. `job:${jobId}`)
     * @param options - Lock options (TTL for auto-release)
     * @returns Lock object or null if could not acquire
     */
    async acquire(
        key: string,
        options: DistributedLockOptions = {},
    ): Promise<DistributedLock | null> {
        const lockId = this.hashKey(key);

        try {
            const result = await this.dataSource.query(
                `SELECT pg_try_advisory_lock($1, $2) as acquired`,
                lockId,
            );

            if (!result[0]?.acquired) {
                this.logger.debug({
                    message:
                        'Could not acquire distributed lock (already in use)',
                    context: DistributedLockService.name,
                    metadata: { key, lockId },
                });
                return null; // Lock is already in use
            }

            this.logger.debug({
                message: 'Distributed lock acquired',
                context: DistributedLockService.name,
                metadata: { key, lockId, ttl: options.ttl },
            });

            return new DistributedLock(
                this.dataSource,
                lockId,
                options.ttl,
                this.logger,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error acquiring distributed lock',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { key, lockId },
            });
            throw error;
        }
    }

    /**
     * Hash string key to two 32-bit integers for PostgreSQL advisory lock.
     * Uses pg_try_advisory_lock(int, int) for 64-bit key space,
     * reducing collision probability from ~1/65k to ~1/4B concurrent locks.
     */
    private hashKey(key: string): [number, number] {
        // djb2 hash — first 32 bits
        let hash1 = 5381;
        for (let i = 0; i < key.length; i++) {
            hash1 = (hash1 << 5) + hash1 + key.charCodeAt(i);
            hash1 = hash1 & hash1;
        }

        // FNV-1a hash — second 32 bits (independent algorithm to minimize correlation)
        let hash2 = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) {
            hash2 ^= key.charCodeAt(i);
            hash2 = Math.imul(hash2, 0x01000193);
            hash2 = hash2 & hash2;
        }

        return [Math.abs(hash1), Math.abs(hash2)];
    }

    /**
     * Verify if lock is in use (without acquiring)
     */
    async isLocked(key: string): Promise<boolean> {
        const lockId = this.hashKey(key);
        try {
            const result = await this.dataSource.query(
                `SELECT pg_try_advisory_lock($1, $2) as acquired`,
                lockId,
            );

            if (result[0]?.acquired) {
                // Release immediately (was just checking)
                await this.dataSource.query(
                    `SELECT pg_advisory_unlock($1, $2)`,
                    lockId,
                );
                return false; // Was not in use
            }

            return true; // Is in use
        } catch (error) {
            this.logger.error({
                message: 'Error checking lock status',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { key, lockId },
            });
            // On error, assume it is locked (fail-safe)
            return true;
        }
    }
}
