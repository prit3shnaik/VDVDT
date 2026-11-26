import { useEffect, useState } from 'react'
import { PageHeader } from '../../components/common/PageHeader'
import { Select } from '../../components/ui/Select'
import { TextField } from '../../components/ui/TextField'
import { DEFAULT_UI_SETTINGS, UI_SETTINGS_KEY, type UiSettings } from '../../lib/uiSettings'

export function SettingsPage() {
  const [settings, setSettings] = useState<UiSettings>(() => {
    const raw = localStorage.getItem(UI_SETTINGS_KEY)
    if (raw) {
      return { ...DEFAULT_UI_SETTINGS, ...(JSON.parse(raw) as Partial<UiSettings>) }
    }
    return DEFAULT_UI_SETTINGS
  })

  useEffect(() => {
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Density, default view, page size, and date/number format. Theme controls are intentionally omitted."
      />

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="space-y-3 rounded-xl border border-line bg-white p-4">
          <Select
            label="Density"
            value={settings.density}
            onChange={(event) => setSettings((current) => ({ ...current, density: event.target.value as UiSettings['density'] }))}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </Select>

          <Select
            label="Default voter view"
            value={settings.defaultView}
            onChange={(event) => setSettings((current) => ({ ...current, defaultView: event.target.value as UiSettings['defaultView'] }))}
          >
            <option value="card">Card</option>
            <option value="table">Table</option>
            <option value="part">By Part</option>
          </Select>

          <TextField
            label="Page size"
            type="number"
            value={settings.pageSize}
            onChange={(event) => setSettings((current) => ({ ...current, pageSize: Number(event.target.value) }))}
            min={10}
            max={200}
            hint="Applies to Voters as the default when you have not already chosen a view or page size there."
          />
        </article>

        <article className="space-y-3 rounded-xl border border-line bg-white p-4">
          <Select
            label="Date format"
            value={settings.dateFormat}
            onChange={(event) => setSettings((current) => ({ ...current, dateFormat: event.target.value as UiSettings['dateFormat'] }))}
          >
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
          </Select>

          <Select
            label="Number format"
            value={settings.numberFormat}
            onChange={(event) => setSettings((current) => ({ ...current, numberFormat: event.target.value as UiSettings['numberFormat'] }))}
          >
            <option value="en-IN">en-IN</option>
            <option value="en-US">en-US</option>
          </Select>

          <p className="rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm text-brand-700">
            This app ships with one intentional light theme only. Density currently applies to the Voters table.
          </p>
        </article>

        <article className="space-y-2 rounded-xl border border-line bg-white p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold text-ink">About</h2>
          <p className="text-sm text-ink-secondary">Built and managed by Lynvo Creative Solutions LLP.</p>
          <p className="text-sm text-ink-secondary">
            Report, support and feedback:{' '}
            <a href="https://lynvo.tech/contact" target="_blank" rel="noreferrer noopener" className="text-brand-700 underline">
              https://lynvo.tech/contact
            </a>
          </p>
          <p className="flex flex-wrap items-center gap-1 text-sm text-ink-secondary">
            <span>
              This work is licensed under{' '}
              <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/" target="_blank" rel="noreferrer noopener" className="text-brand-700 underline">
                CC BY-NC-ND 4.0
              </a>
            </span>
            <img src="https://mirrors.creativecommons.org/presskit/icons/cc.svg" alt="CC" className="ml-1 h-4 w-4" />
            <img src="https://mirrors.creativecommons.org/presskit/icons/by.svg" alt="BY" className="ml-1 h-4 w-4" />
            <img src="https://mirrors.creativecommons.org/presskit/icons/nc.svg" alt="NC" className="ml-1 h-4 w-4" />
            <img src="https://mirrors.creativecommons.org/presskit/icons/nd.svg" alt="ND" className="ml-1 h-4 w-4" />
          </p>
        </article>
      </section>
    </div>
  )
}
