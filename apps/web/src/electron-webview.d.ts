/**
 * Ambient type declaration for Electron's <webview> intrinsic JSX element.
 * Only used at compile time — the element is only rendered when running inside Electron.
 */
import type React from 'react';

declare module 'react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.HTMLAttributes<HTMLElement> & {
        ref?: React.Ref<HTMLElement>;
        src?: string;
        width?: string;
        height?: string;
        allowpopups?: string;
        partition?: string;
        disablewebsecurity?: string;
        useragent?: string;
        preload?: string;
      };
    }
  }
}
