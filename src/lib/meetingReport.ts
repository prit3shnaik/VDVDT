import type { MeetingInvitee, MeetingAttendanceStatus, Voter } from './types'
import { normalizeGroupingValue } from './searchUtils'

export const ATTENDANCE_STATUS_OPTIONS: Array<{ value: MeetingAttendanceStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'attended', label: 'Attended' },
  { value: 'next_meeting', label: 'Next Meeting' },
  { value: 'absent', label: 'Absent' },
  { value: 'not_attended', label: 'Not Attended' },
  { value: 'called', label: 'Called' },
  { value: 'called_confirmed', label: 'Called - Confirmed' },
  { value: 'called_notreceived', label: 'Called - Not Received' },
  { value: 'called_suspense', label: 'Called - Suspense' },
  { value: 'personal_call', label: 'Personal Call' },
]

export type MeetingFieldKey =
  | 'srNo'
  | 'srNoRoll'
  | 'photo'
  | 'ward'
  | 'part'
  | 'section'
  | 'sectionName'
  | 'name'
  | 'relativeName'
  | 'relation'
  | 'epic'
  | 'houseNo'
  | 'age'
  | 'dob'
  | 'contact1'
  | 'contact2'
  | 'gender'
  | 'religion'
  | 'state'
  | 'familyMembersCount'
  | 'status'
  | 'callNote'

export interface FieldOption<K extends string> {
  key: K
  label: string
}

export const MEETING_FIELD_OPTIONS: FieldOption<MeetingFieldKey>[] = [
  { key: 'srNo', label: 'Sr No' },
  { key: 'photo', label: 'Photo' },
  { key: 'name', label: 'Name' },
  { key: 'epic', label: 'EPIC' },
  { key: 'relativeName', label: 'Relative Name' },
  { key: 'relation', label: 'Relative Relation' },
  { key: 'houseNo', label: 'House Number' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'ward', label: 'Ward' },
  { key: 'part', label: 'Part' },
  { key: 'section', label: 'Section' },
  { key: 'srNoRoll', label: 'Voter Sr No' },
  { key: 'religion', label: 'Religion' },
  { key: 'sectionName', label: 'Section Name' },
  { key: 'contact1', label: 'Contact No 1' },
  { key: 'contact2', label: 'Contact No 2' },
  { key: 'dob', label: 'DOB' },
  { key: 'familyMembersCount', label: 'Family Members Count' },
  { key: 'status', label: 'Status' },
  { key: 'callNote', label: 'Call Note' },
  { key: 'state', label: 'State' },
]

export const DEFAULT_TABLE_COLUMNS: MeetingFieldKey[] = [
  'srNo', 'photo', 'name', 'epic', 'relativeName', 'relation', 'houseNo', 'age', 'gender', 'ward', 'part', 'section', 'srNoRoll', 'religion', 'sectionName', 'contact1', 'contact2', 'familyMembersCount', 'status', 'callNote',
]

export function fieldTextValue(voter: Voter | null | undefined, key: MeetingFieldKey): string {
  if (!voter) return '-'
  switch (key) {
    case 'srNo': return ''
    case 'photo': return ''
    case 'ward': return voter.ward_no != null ? String(voter.ward_no) : '-'
    case 'part': return voter.part_no != null ? String(voter.part_no) : '-'
    case 'section': return voter.section != null ? String(voter.section) : '-'
    case 'sectionName': return voter.section_name ?? '-'
    case 'name': return voter.name ?? '-'
    case 'relativeName': return voter.relative_name ?? '-'
    case 'relation': return voter.relative_relation ?? '-'
    case 'epic': return voter.epic_no ?? '-'
    case 'houseNo': return voter.house_no ?? '-'
    case 'age': return voter.age != null ? String(voter.age) : '-'
    case 'dob': return voter.date_of_birth ?? '-'
    case 'contact1': return voter.contact_no_1 ?? '-'
    case 'contact2': return voter.contact_no_2 ?? '-'
    case 'gender': return voter.gender ?? '-'
    case 'religion': return voter.religion ?? '-'
    case 'state': return (voter as Voter & { state?: string }).state ?? '-'
    case 'srNoRoll': return voter.sr_no_roll != null ? String(voter.sr_no_roll) : '-'
    case 'familyMembersCount': return '0'
    case 'status': return '-'
    case 'callNote': return '-'
    default: return '-'
  }
}

export function fieldIsBold(key: MeetingFieldKey): boolean {
  return key === 'name'
}

export function fieldIsCenter(key: MeetingFieldKey): boolean {
  return key === 'srNo' || key === 'age' || key === 'ward' || key === 'part' || key === 'section'
}

export type ReportFieldKey = MeetingFieldKey | 'status' | 'callNote'

export const REPORT_FIELD_OPTIONS: FieldOption<ReportFieldKey>[] = [
  { key: 'srNo', label: 'Sr No' },
  { key: 'photo', label: 'Photo' },
  { key: 'status', label: 'Attendance Status' },
  { key: 'callNote', label: 'Call Note' },
  { key: 'ward', label: 'Ward' },
  { key: 'part', label: 'Part No' },
  { key: 'section', label: 'Section' },
  { key: 'sectionName', label: 'Section Name' },
  { key: 'name', label: 'Name' },
  { key: 'relativeName', label: 'Relative Name' },
  { key: 'relation', label: 'Relative Relation' },
  { key: 'epic', label: 'EPIC No' },
  { key: 'houseNo', label: 'House No' },
  { key: 'age', label: 'Age' },
  { key: 'dob', label: 'DOB' },
  { key: 'contact1', label: 'Contact No 1' },
  { key: 'contact2', label: 'Contact No 2' },
  { key: 'gender', label: 'Gender' },
  { key: 'religion', label: 'Religion' },
  { key: 'state', label: 'State' },
]

export const DEFAULT_REPORT_FIELD_KEYS: ReportFieldKey[] = [
  'srNo', 'photo', 'name', 'contact1',
]

export function defaultReportFields(): Record<ReportFieldKey, boolean> {
  const map = {} as Record<ReportFieldKey, boolean>
  for (const option of REPORT_FIELD_OPTIONS) map[option.key] = DEFAULT_REPORT_FIELD_KEYS.includes(option.key)
  return map
}

export type GroupByValue = 'none' | 'family' | 'section' | 'ward' | 'part' | 'status'

export const GROUP_BY_OPTIONS: Array<{ value: GroupByValue; label: string }> = [
  { value: 'none', label: 'No grouping' },
  { value: 'family', label: 'Family-wise' },
  { value: 'section', label: 'Section-wise' },
  { value: 'ward', label: 'Ward-wise' },
  { value: 'part', label: 'Part-wise' },
  { value: 'status', label: 'Status-wise' },
]

export interface ReportRow {
  invitee: MeetingInvitee | null
  voter: Voter | null
}

export function reportRowCellValue(ir: ReportRow, key: ReportFieldKey, srNo: number, photoUrl: string): string {
  if (key === 'srNo') return String(srNo)
  if (key === 'photo') return photoUrl
  if (key === 'status') return ir.invitee
    ? ATTENDANCE_STATUS_OPTIONS.find((s) => s.value === ir.invitee?.attendance_status)?.label ?? ir.invitee.attendance_status
    : 'Not Invited'
  if (key === 'callNote') return ir.invitee?.call_note ?? '-'
  return fieldTextValue(ir.voter, key)
}

export function reportRowGroupInfo(
  row: ReportRow,
  groupBy: GroupByValue,
  epicToVoter: Map<string, Voter>,
): { key: string; label: string } {
  switch (groupBy) {
    case 'family': {
      const headEpicRaw = row.voter?.family_head_epic || row.voter?.epic_no
      const headEpic = normalizeGroupingValue(headEpicRaw)
      const headVoter = epicToVoter.get(headEpic)
      const label = headVoter
        ? `Family: ${headVoter.name} (${headVoter.epic_no})`
        : `Family: ${row.voter?.name ?? 'Unknown'}`
      return { key: headEpic || 'UNKNOWN', label }
    }
    case 'section':
      return { key: String(row.voter?.section ?? ''), label: row.voter?.section != null ? `Section ${row.voter.section}` : 'Section - (unassigned)' }
    case 'ward':
      return { key: String(row.voter?.ward_no ?? ''), label: row.voter?.ward_no != null ? `Ward ${row.voter.ward_no}` : 'Ward - (unassigned)' }
    case 'part':
      return { key: String(row.voter?.part_no ?? ''), label: row.voter?.part_no != null ? `Part ${row.voter.part_no}` : 'Part - (unassigned)' }
    case 'status':
      return { key: row.invitee?.attendance_status ?? 'not_invited', label: row.invitee
        ? ATTENDANCE_STATUS_OPTIONS.find((s) => s.value === row.invitee?.attendance_status)?.label ?? row.invitee.attendance_status
        : 'Not Invited' }
    default:
      return { key: '', label: '' }
  }
}

export function groupReportRows(
  rows: ReportRow[],
  groupBy: GroupByValue,
  epicToVoter: Map<string, Voter>,
): Array<[string, ReportRow[]]> {
  if (groupBy === 'none') return [['', rows]]
  const groups = new Map<string, { label: string; rows: ReportRow[] }>()
  for (const row of rows) {
    const { key, label } = reportRowGroupInfo(row, groupBy, epicToVoter)
    const existing = groups.get(key)
    if (existing) existing.rows.push(row)
    else groups.set(key, { label, rows: [row] })
  }
  return Array.from(groups.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((g) => [g.label, g.rows])
}
