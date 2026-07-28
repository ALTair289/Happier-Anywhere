const values = new Map<string, unknown>();

export function resetReactNativeMmkvStub(): void {
    values.clear();
}

export class MMKV {
    getString(key: string): string | undefined {
        const value = values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string): number | undefined {
        const value = values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    set(key: string, value: unknown): void {
        values.set(key, value);
    }

    delete(key: string): void {
        values.delete(key);
    }

    getAllKeys(): string[] {
        return [...values.keys()];
    }

    clearAll(): void {
        values.clear();
    }
}
