export const ACTIVE_VOTER_SQL = 'COALESCE(is_active, 1) = 1'
export const INACTIVE_VOTER_SQL = 'COALESCE(is_active, 1) = 0'

export function activeVoterSql(alias?: string): string {
  const column = alias ? `${alias}.is_active` : 'is_active'
  return `COALESCE(${column}, 1) = 1`
}

export function inactiveVoterSql(alias?: string): string {
  const column = alias ? `${alias}.is_active` : 'is_active'
  return `COALESCE(${column}, 1) = 0`
}

export function isVoterActive(value: unknown): boolean {
  if (value === false || value === 0 || value === '0') return false
  return true
}
