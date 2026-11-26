export interface UiSettings {
  density: 'compact' | 'comfortable'
  defaultView: 'card' | 'table' | 'part'
  pageSize: number
  dateFormat: 'DD/MM/YYYY' | 'MM/DD/YYYY'
  numberFormat: 'en-IN' | 'en-US'
}

export const UI_SETTINGS_KEY = 'voterdata-ui-settings'

export const DEFAULT_UI_SETTINGS: UiSettings = {
  density: 'comfortable',
  defaultView: 'table',
  pageSize: 20,
  dateFormat: 'DD/MM/YYYY',
  numberFormat: 'en-IN',
}

export function readUiSettings(): UiSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_UI_SETTINGS
  }

  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY)
    if (!raw) {
      return DEFAULT_UI_SETTINGS
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>
    return {
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      defaultView: parsed.defaultView === 'card' || parsed.defaultView === 'part' ? parsed.defaultView : 'table',
      pageSize: Number.isFinite(parsed.pageSize) ? Math.min(200, Math.max(10, Number(parsed.pageSize))) : 20,
      dateFormat: parsed.dateFormat === 'MM/DD/YYYY' ? 'MM/DD/YYYY' : 'DD/MM/YYYY',
      numberFormat: parsed.numberFormat === 'en-US' ? 'en-US' : 'en-IN',
    }
  } catch {
    return DEFAULT_UI_SETTINGS
  }
}
