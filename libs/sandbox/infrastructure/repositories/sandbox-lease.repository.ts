import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SandboxLeaseModel } from './schemas/sandbox-lease.model';

/**
 * Decompose a prKey ("{orgId}:{repoId}:{prNumber}") into its parts.
 *
 * SECURITY: only accepts the canonical shape — a UUID organizationId in
 * segment 0 is required. Anything else throws so a bad prKey can't taint
 * the lease doc with the wrong organizationId. Caller is expected to have
 * already validated via assertValidPrKey() in the lease manager.
 */
const ORG_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decomposePrKey(prKey: string): {
    organizationId: string;
    repositoryId: string;
    prNumber?: string;
} {
    const parts = prKey.split(':');
    if (parts.length < 3 || parts.length > 4) {
        throw new Error(
            `decomposePrKey: invalid shape, expected 3 or 4 segments, got ${parts.length}`,
        );
    }
    if (!ORG_UUID_RE.test(parts[0])) {
        throw new Error(
            `decomposePrKey: first segment must be a UUID organizationId`,
        );
    }
    // PR mode shape: <orgId>:<repoId>:<prNumber>
    if (parts.length === 3) {
        return {
            organizationId: parts[0],
            repositoryId: parts[1],
            prNumber: parts[2],
        };
    }
    // CLI mode shape: <orgId>:<repoId>:cli:<branch>
    return {
        organizationId: parts[0],
        repositoryId: parts[1],
    };
}

@Injectable()
export class SandboxLeaseRepository {
    constructor(
        @InjectModel(SandboxLeaseModel.name)
        private readonly leaseModel: Model<SandboxLeaseModel>,
    ) {}

    /**
     * Atomically acquire (or join) a lease for the given prKey.
     *
     * Single findOneAndUpdate with BOTH operators in one update document:
     *   - $setOnInsert: sets initial state/timestamps on the INSERT path only
     *   - $inc: { leaseCount: 1 } increments the counter on BOTH insert and update paths
     *
     * On INSERT:  MongoDB applies $setOnInsert (state='CREATING', dates) and $inc
     *             (leaseCount 0→1). Returned doc has leaseCount === 1.
     * On UPDATE:  $setOnInsert is a no-op; $inc bumps leaseCount to N+1.
     *
     * Caller identifies itself as creator when doc.leaseCount === 1.
     * Caller must poll when doc.leaseCount > 1 and doc.state === 'CREATING'.
     *
     * CRITICAL: Do NOT split into find + update — atomicity required (Pitfall 2).
     * Do NOT add a separate incrementLease() — this method handles both paths.
     */
    async upsertAcquire(
        prKey: string,
        leaseTtlMs: number,
        consumer?: string,
    ): Promise<SandboxLeaseModel> {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + leaseTtlMs);
        const decomposed = decomposePrKey(prKey);

        const doc = await this.leaseModel.findOneAndUpdate(
            { _id: prKey },
            {
                $setOnInsert: {
                    state: 'CREATING',
                    createdAt: now,
                    expiresAt,
                    ...decomposed,
                },
                // Track the most recent consumer label so it's queryable in
                // Mongo without parsing logs. Updated on every acquire (both
                // insert and update paths).
                $set: consumer ? { consumer } : {},
                $inc: { leaseCount: 1 },
            },
            { upsert: true, new: true },
        );

        return doc;
    }

    /**
     * Atomically decrement leaseCount by 1. Returns the updated document
     * (which may have leaseCount === 0 after the decrement).
     */
    async decrementLease(prKey: string): Promise<SandboxLeaseModel | null> {
        return this.leaseModel.findOneAndUpdate(
            { _id: prKey },
            { $inc: { leaseCount: -1 } },
            { new: true },
        );
    }

    /**
     * Transition a CREATING lease to READY and record the sandboxId.
     * Only updates if the document is still in CREATING state to prevent
     * overwriting a concurrent INVALIDATED state change.
     */
    async updateReady(prKey: string, sandboxId: string): Promise<void> {
        await this.leaseModel.updateOne(
            { _id: prKey, state: 'CREATING' },
            { $set: { state: 'READY', sandboxId } },
        );
    }

    /**
     * Mark a CREATING lease as INVALIDATED (mid-create race handling).
     * The create path will check for this state after completing and kill the sandbox.
     */
    async markInvalidated(prKey: string): Promise<void> {
        await this.leaseModel.updateOne(
            { _id: prKey, state: 'CREATING' },
            { $set: { state: 'INVALIDATED' } },
        );
    }

    /**
     * Find a lease document by its prKey (_id).
     */
    async findByPrKey(prKey: string): Promise<SandboxLeaseModel | null> {
        return this.leaseModel.findOne({ _id: prKey });
    }

    /**
     * Find all leases past their expiry date. Used by the reaper regardless
     * of leaseCount — crashed-worker leases stay at leaseCount > 0 forever.
     */
    async findExpired(now: Date): Promise<SandboxLeaseModel[]> {
        return this.leaseModel.find({ expiresAt: { $lt: now } });
    }

    /**
     * Delete a lease document by prKey. Called by invalidate() after soft-drain
     * and by the reaper after killing the E2B sandbox.
     */
    async delete(prKey: string): Promise<void> {
        await this.leaseModel.deleteOne({ _id: prKey });
    }
}
