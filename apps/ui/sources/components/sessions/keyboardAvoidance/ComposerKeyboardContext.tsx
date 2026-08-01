import * as React from 'react';
import type { SharedValue } from 'react-native-reanimated';

export type ComposerKeyboardLayout = Readonly<{
    availablePanelHeight: SharedValue<number>;
    bottomInset: SharedValue<number>;
    composerHeight: SharedValue<number>;
    isKeyboardLiftSuppressed: SharedValue<boolean>;
    keyboardHeightForInset: SharedValue<number>;
    keyboardHeightLive: SharedValue<number>;
    keyboardProgress: SharedValue<number>;
    // Settled total: what the list's bottom inset will be once the current keyboard transition
    // finishes. Notified to subscribers, and the value every JS-side consumer must agree on.
    listBottomInset: SharedValue<number>;
    // The same total, sampled continuously on the UI thread. Rendering reads this one so the
    // transcript follows the keyboard frame by frame instead of jumping to the settled total in
    // one commit whenever the JS thread is busy. The two agree at rest.
    listBottomInsetAnimated: SharedValue<number>;
    getKeyboardHeight?: () => number;
    retainKeyboardLift?: () => () => void;
    setComposerInputFocused?: (focused: boolean) => void;
    setComposerMeasuredHeight: (height: number) => void;
    setScaffoldMeasuredHeight?: (height: number) => void;
    subscribeAvailablePanelHeight?: (listener: (height: number) => void) => () => void;
    subscribeKeyboardHeight?: (listener: (height: number) => void) => () => void;
    subscribeListBottomInset?: (listener: (height: number) => void) => () => void;
}>;

const ComposerKeyboardContext = React.createContext<ComposerKeyboardLayout | null>(null);

export function ComposerKeyboardProvider(props: Readonly<{
    children: React.ReactNode;
    layout: ComposerKeyboardLayout;
}>): React.ReactElement {
    return (
        <ComposerKeyboardContext.Provider value={props.layout}>
            {props.children}
        </ComposerKeyboardContext.Provider>
    );
}

export function useComposerKeyboardLayout(): ComposerKeyboardLayout | null {
    return React.useContext(ComposerKeyboardContext);
}
