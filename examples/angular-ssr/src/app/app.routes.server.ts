import { RenderMode, ServerRoute } from '@angular/ssr';

// Real SSR on every request (not prerendered), so the server HTML is checked as it would be in production.
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Server }];
