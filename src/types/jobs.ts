export type JobStatus = 'Applied' | 'Selected' | 'Rejected' | 'Appointed' | 'Resigned'

export interface Job {
  id: string
  voter_id: string
  department_name: string
  status: JobStatus
  note: string
  created_at: string
  updated_at: string
}

export type JobInsert = Omit<Job, 'id' | 'created_at' | 'updated_at'>
