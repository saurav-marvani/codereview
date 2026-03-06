#!/usr/bin/env npx ts-node
/**
 * Internal tool for generating self-hosted license keys.
 *
 * Usage:
 *   npx ts-node scripts/license/generate-license-key.ts \
 *     --org "acme-corp" \
 *     --plan "enterprise" \
 *     --seats 50 \
 *     --expires "2026-12-31" \
 *     --customer "Acme Corporation" \
 *     --private-key ./private.pem
 *
 * To generate a keypair (run once):
 *   npx ts-node scripts/license/generate-license-key.ts --generate-keypair
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

function base64UrlEncode(buffer: Buffer): string {
    return buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function generateKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    fs.writeFileSync('license-public.pem', publicKey);
    fs.writeFileSync('license-private.pem', privateKey);

    console.log('Keypair generated:');
    console.log('  Public key:  license-public.pem');
    console.log('  Private key: license-private.pem');
    console.log('\nPublic key (embed in service):');
    console.log(publicKey);
}

function generateLicenseKey(args: {
    org: string;
    plan: string;
    seats: number;
    expires: string;
    customer: string;
    privateKeyPath: string;
    features?: string[];
}) {
    const privateKeyPem = fs.readFileSync(args.privateKeyPath, 'utf-8');
    const privateKey = crypto.createPrivateKey(privateKeyPem);

    const now = Math.floor(Date.now() / 1000);
    const exp = Math.floor(new Date(args.expires).getTime() / 1000);

    const header = { alg: 'EdDSA', typ: 'JWT' };
    const payload = {
        iss: 'kodus.io',
        sub: args.org,
        iat: now,
        exp,
        plan: args.plan,
        seats: args.seats,
        features: args.features || ['all'],
        customer: args.customer,
    };

    const headerB64 = base64UrlEncode(
        Buffer.from(JSON.stringify(header), 'utf-8'),
    );
    const payloadB64 = base64UrlEncode(
        Buffer.from(JSON.stringify(payload), 'utf-8'),
    );

    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = crypto.sign(
        null,
        Buffer.from(signingInput),
        privateKey,
    );
    const signatureB64 = base64UrlEncode(signature);

    const jwt = `${headerB64}.${payloadB64}.${signatureB64}`;

    console.log('\nGenerated License Key:');
    console.log(jwt);
    console.log('\nPayload:');
    console.log(JSON.stringify(payload, null, 2));
    console.log(`\nExpires: ${new Date(exp * 1000).toISOString()}`);
}

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes('--generate-keypair')) {
    generateKeypair();
    process.exit(0);
}

function getArg(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
}

const org = getArg('org');
const plan = getArg('plan') || 'enterprise';
const seats = parseInt(getArg('seats') || '0', 10);
const expires = getArg('expires');
const customer = getArg('customer') || '';
const privateKeyPath = getArg('private-key');
const features = getArg('features')?.split(',');

if (!org || !expires || !privateKeyPath) {
    console.error(
        'Usage: generate-license-key.ts --org <org> --expires <date> --private-key <path> [--plan <plan>] [--seats <n>] [--customer <name>] [--features <f1,f2>]',
    );
    console.error(
        '\nOr generate a keypair: generate-license-key.ts --generate-keypair',
    );
    process.exit(1);
}

generateLicenseKey({ org, plan, seats, expires, customer, privateKeyPath, features });
