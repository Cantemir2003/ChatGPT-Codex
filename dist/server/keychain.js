import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,400}$/;
export function isValidKey(value) {
    return typeof value === 'string' && value.trim() === value && KEY_PATTERN.test(value);
}
/** Only the platform keychain persists credentials. Secrets travel through pipes, never argv. */
export class MacOSKeyStore {
    helperPath;
    constructor(helperPath = resolve('bin/keychain-helper')) {
        this.helperPath = helperPath;
    }
    invoke(operation, input = '') {
        if (process.platform !== 'darwin')
            return Promise.reject(new Error('macOS Keychain is unavailable.'));
        return new Promise((resolveOutput, reject) => {
            const child = spawn(this.helperPath, [operation], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            const chunks = [];
            let size = 0;
            let settled = false;
            const fail = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                child.kill('SIGKILL');
                reject(new Error('macOS Keychain could not complete this operation.'));
            };
            const timer = setTimeout(fail, 60_000);
            timer.unref();
            child.once('error', fail);
            child.stdin.on('error', fail);
            // Never surface helper stderr, which is outside the application's trusted error vocabulary.
            child.stderr.resume();
            child.stdout.on('data', (chunk) => {
                size += chunk.length;
                if (size > 8192) {
                    fail();
                    return;
                }
                chunks.push(chunk);
            });
            child.once('close', code => {
                if (settled)
                    return;
                if (code !== 0) {
                    fail();
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolveOutput(Buffer.concat(chunks).toString('utf8').trim());
            });
            child.stdin.end(input, 'utf8');
        });
    }
    async get() {
        const value = await this.invoke('get');
        if (!value)
            return null;
        if (!isValidKey(value))
            throw new Error('The saved API key is invalid. Replace it in Settings.');
        return value;
    }
    async set(key) {
        if (!isValidKey(key))
            throw new Error('Enter a valid OpenAI API key.');
        await this.invoke('set', key);
    }
    async remove() { await this.invoke('delete'); }
    async status() {
        try {
            const result = await this.invoke('status');
            if (result !== 'configured' && result !== 'empty')
                return { configured: false, storage: 'unavailable' };
            return { configured: result === 'configured', storage: 'macos-keychain' };
        }
        catch {
            return { configured: false, storage: 'unavailable' };
        }
    }
}
