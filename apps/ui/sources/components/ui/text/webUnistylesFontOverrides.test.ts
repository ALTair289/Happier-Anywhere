import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import {
    scanDocumentForUnistylesFontMetrics,
    ensureOverrideStyleElement,
    observeWebUnistylesFontMetricSources,
    syncOverrideStyleElement,
    setRootCssVar,
    HAPPIER_UI_FONT_SCALE_CSS_VAR,
    HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID,
} from './webUnistylesFontOverrides';

describe('webUnistylesFontOverrides', () => {
    it('generates calc(var(--scale)) overrides for Unistyles font rules', () => {
        const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`);
        const { document } = dom.window;

        const styleTag = document.createElement('style');
        styleTag.textContent = `
            .unistyles_a1 { font-size: 16px; line-height: 24px; letter-spacing: 0.15px; color: red; }
            .unistyles_b2 { font-size: 14px; }
        `;
        document.head.appendChild(styleTag);

        const metrics = new Map<string, { fontSize?: string; lineHeight?: string; letterSpacing?: string }>();
        const added = scanDocumentForUnistylesFontMetrics(document, metrics);
        expect(added).toBe(2);

        const overrideEl = ensureOverrideStyleElement(document);
        const appended = syncOverrideStyleElement(overrideEl, metrics);
        expect(appended).toBe(2);

        const css = overrideEl.textContent ?? '';
        expect(css).toContain(`.${'unistyles_a1'}`);
        expect(css).toContain(`font-size: calc(16px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);
        expect(css).toContain(`line-height: calc(24px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);
        expect(css).toContain(`letter-spacing: calc(0.15px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);

        expect(css).toContain(`.${'unistyles_b2'}`);
        expect(css).toContain(`font-size: calc(14px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);
    });

    it('sets the root CSS variable to the provided scale', () => {
        const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`);
        const { document } = dom.window;

        setRootCssVar(document, 1.1);
        const raw = document.documentElement.style.getPropertyValue(HAPPIER_UI_FONT_SCALE_CSS_VAR);
        expect(raw.trim()).toBe('1.1');
    });

    it('does not duplicate override rules when synced repeatedly', () => {
        const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`);
        const { document } = dom.window;

        const styleTag = document.createElement('style');
        styleTag.textContent = `.unistyles_a1 { font-size: 16px; }`;
        document.head.appendChild(styleTag);

        const metrics = new Map<string, { fontSize?: string; lineHeight?: string; letterSpacing?: string }>();
        scanDocumentForUnistylesFontMetrics(document, metrics);

        const overrideEl = ensureOverrideStyleElement(document);
        expect(overrideEl.id).toBe(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID);

        const appended1 = syncOverrideStyleElement(overrideEl, metrics);
        const appended2 = syncOverrideStyleElement(overrideEl, metrics);
        expect(appended1).toBe(1);
        expect(appended2).toBe(0);

        const css = overrideEl.textContent ?? '';
        const occurrences = css.split('.unistyles_a1').length - 1;
        expect(occurrences).toBe(1);
    });

    it('observes only bounded stylesheet sources and root font-size mutations', () => {
        const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`);
        const { document } = dom.window;
        const originalMutationObserver = globalThis.MutationObserver;
        const observed: Array<{
            target: Node;
            options: MutationObserverInit;
            callback: MutationCallback;
            disconnected: boolean;
        }> = [];

        class FakeMutationObserver {
            private readonly callback: MutationCallback;

            constructor(callback: MutationCallback) {
                this.callback = callback;
            }

            observe(target: Node, options: MutationObserverInit) {
                observed.push({
                    target,
                    options,
                    callback: this.callback,
                    disconnected: false,
                });
            }

            disconnect() {
                for (const entry of observed) {
                    if (entry.callback === this.callback) entry.disconnected = true;
                }
            }
        }

        try {
            (globalThis as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver =
                FakeMutationObserver as unknown as typeof MutationObserver;
            const onChange = vi.fn();
            const dispose = observeWebUnistylesFontMetricSources(document, onChange);

            expect(observed).toHaveLength(2);
            expect(observed[0]).toMatchObject({
                target: document.head,
                options: { childList: true },
            });
            expect(observed[0]?.options.subtree).toBeUndefined();
            expect(observed[0]?.options.characterData).toBeUndefined();
            expect(observed[0]?.options.attributes).toBeUndefined();
            expect(observed[1]).toMatchObject({
                target: document.documentElement,
                options: { attributes: true, attributeFilter: ['style'] },
            });
            expect(observed[1]?.options.subtree).toBeUndefined();
            expect(observed[1]?.options.characterData).toBeUndefined();

            const meta = document.createElement('meta');
            observed[0]?.callback([
                { type: 'childList', addedNodes: [meta] } as unknown as MutationRecord,
            ], {} as MutationObserver);
            expect(onChange).not.toHaveBeenCalled();

            const override = ensureOverrideStyleElement(document);
            observed[0]?.callback([
                { type: 'childList', addedNodes: [override] } as unknown as MutationRecord,
            ], {} as MutationObserver);
            expect(onChange).not.toHaveBeenCalled();

            const style = document.createElement('style');
            observed[0]?.callback([
                { type: 'childList', addedNodes: [style] } as unknown as MutationRecord,
            ], {} as MutationObserver);
            expect(onChange).toHaveBeenCalledTimes(1);

            setRootCssVar(document, 1.15);
            observed[1]?.callback([
                { type: 'attributes', target: document.documentElement, attributeName: 'style' } as unknown as MutationRecord,
            ], {} as MutationObserver);
            expect(onChange).toHaveBeenCalledTimes(1);

            document.documentElement.style.fontSize = '18px';
            observed[1]?.callback([
                { type: 'attributes', target: document.documentElement, attributeName: 'style' } as unknown as MutationRecord,
            ], {} as MutationObserver);
            expect(onChange).toHaveBeenCalledTimes(2);

            dispose();
            expect(observed.every((entry) => entry.disconnected)).toBe(true);
        } finally {
            globalThis.MutationObserver = originalMutationObserver;
        }
    });
});
