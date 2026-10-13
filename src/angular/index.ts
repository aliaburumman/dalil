// `dalil/angular`: provideDalil(config) starts Dalil in the browser after the app boots, outside the zone.
// Angular 16+. Plain functions only (no decorators), so no Angular compilation step is needed.
import * as ng from '@angular/core'
import { isPlatformBrowser } from '@angular/common'
import { destroy, init, type DalilWebConfig } from '../web'
import { loadOrTimeout, resolveConfig, startOnFirst, type StartSignal } from './start'

export type { DalilWebConfig }
export { startOnFirst, resolveConfig }

// Newer Angular majors export members that older ones lack; look them up dynamically.
const NG = ng as unknown as Record<string, unknown>

type AfterNextRender = (cb: () => void, opts: { injector: ng.Injector }) => unknown

export function provideDalil(config: DalilWebConfig | (() => DalilWebConfig)): ng.EnvironmentProviders {
  const initializer = () => {
    if (!isPlatformBrowser(ng.inject(ng.PLATFORM_ID))) return
    const cfg = resolveConfig(config)
    const injector = ng.inject(ng.Injector)
    const zone = ng.inject(ng.NgZone)
    const appRef = ng.inject(ng.ApplicationRef)
    const destroyRef = ng.inject(ng.DestroyRef)

    const signals: StartSignal[] = []
    const afterNextRender = NG['afterNextRender'] as AfterNextRender | undefined
    if (typeof afterNextRender === 'function') {
      signals.push((fire) => {
        try {
          afterNextRender(fire, { injector })
        } catch {
          /* fall back to the other signals */
        }
      })
    }
    signals.push((fire) => {
      const sub = appRef.isStable.subscribe((s) => s && fire())
      return () => sub.unsubscribe()
    })
    signals.push(loadOrTimeout(5000))

    let started = false
    const stop = startOnFirst(() => {
      started = true
      zone.runOutsideAngular(() => init(cfg))
    }, signals)
    destroyRef.onDestroy(() => {
      stop()
      if (started) destroy()
    })
  }

  const envInit = NG['provideEnvironmentInitializer'] as ((fn: () => void) => ng.EnvironmentProviders) | undefined
  if (typeof envInit === 'function') return envInit(initializer)
  return ng.makeEnvironmentProviders([
    { provide: NG['ENVIRONMENT_INITIALIZER'] as ng.InjectionToken<unknown>, multi: true, useValue: initializer },
  ])
}
