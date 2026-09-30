import { useLayoutEffect } from 'react';

// Desktop browsers can reveal their tabs/address bar over the page in native
// fullscreen without updating visualViewport or safe-area-inset-top. Reserve
// room for that overlay, accounting for page zoom and any space already reserved.
const FULLSCREEN_TOOLBAR_HEIGHT = 88;

export function useBrowserInsets() {
    useLayoutEffect(() => {
        const fullscreen = window.matchMedia('(display-mode: fullscreen)');
        const desktop = window.matchMedia('(hover: hover) and (pointer: fine)');
        const update = () => {
            let inset = 0;
            if (fullscreen.matches && desktop.matches && !document.fullscreenElement
                && window.innerWidth > 0 && window.outerWidth > 0) {
                const zoom = window.outerWidth / window.innerWidth;
                const reserved = Math.max(0, window.outerHeight - window.innerHeight * zoom);
                inset = Math.max(0, FULLSCREEN_TOOLBAR_HEIGHT - reserved) / zoom;
            }
            document.documentElement.style.setProperty('--browser-top-inset', `${inset}px`);
        };
        update();
        fullscreen.addEventListener('change', update);
        desktop.addEventListener('change', update);
        window.addEventListener('resize', update);
        document.addEventListener('fullscreenchange', update);
        return () => {
            fullscreen.removeEventListener('change', update);
            desktop.removeEventListener('change', update);
            window.removeEventListener('resize', update);
            document.removeEventListener('fullscreenchange', update);
            document.documentElement.style.removeProperty('--browser-top-inset');
        };
    }, []);
}
