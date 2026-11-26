import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { fetchApiJson } from '../../lib/d1Query'
import type { Booth, Election, UserProfile } from '../../lib/types'

interface AgentRow {
  id: string
  booth_id: string
  user_id: string
  full_name: string | null
  email: string
}

interface LeaderLinkRow {
  id: string
  team_leader_id: string
  user_id: string
  full_name: string | null
  email: string
  leader_name: string | null
}

interface LeaderOption {
  id: string
  display_name: string | null
  voter_name?: string | null
}

export function BoothConfigPage() {
  const [elections, setElections] = useState<Election[]>([])
  const [electionId, setElectionId] = useState('')
  const [booths, setBooths] = useState<Booth[]>([])
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [users, setUsers] = useState<UserProfile[]>([])
  const [links, setLinks] = useState<LeaderLinkRow[]>([])
  const [leaders, setLeaders] = useState<LeaderOption[]>([])
  const [elForm, setElForm] = useState({ name: '', poll_date: '', status: 'draft' as Election['status'] })
  const [boothForm, setBoothForm] = useState({ part_no: '', section: '', name: '', location: '' })
  const [agentForm, setAgentForm] = useState({ booth_id: '', user_id: '' })
  const [leaderForm, setLeaderForm] = useState({ team_leader_id: '', user_id: '' })

  const reload = async () => {
    const el = await fetchApiJson<{ elections: Election[] }>('/api/booth/elections')
    setElections(el.elections)
    const current = electionId || el.elections[0]?.id || ''
    if (!electionId && current) setElectionId(current)
    if (current) {
      const [b, a] = await Promise.all([
        fetchApiJson<{ booths: Booth[] }>(`/api/booth/booths?election_id=${current}`),
        fetchApiJson<{ agents: AgentRow[] }>(`/api/booth/agents?election_id=${current}`),
      ])
      setBooths(b.booths)
      setAgents(a.agents)
    }
    const [u, l, tl] = await Promise.all([
      fetchApiJson<{ users: UserProfile[] }>('/api/admin/users?limit=500'),
      fetchApiJson<{ links: LeaderLinkRow[] }>('/api/field/leaders'),
      fetchApiJson<{ teamLeaders: LeaderOption[] }>('/api/team-leaders?limit=500'),
    ])
    setUsers(u.users)
    setLinks(l.links)
    setLeaders(tl.teamLeaders)
  }

  useEffect(() => {
    void reload().catch((err) => toast.error(err instanceof Error ? err.message : 'Load failed'))
    // Initial load only; later mutations call reload directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!electionId) return
    void Promise.all([
      fetchApiJson<{ booths: Booth[] }>(`/api/booth/booths?election_id=${electionId}`),
      fetchApiJson<{ agents: AgentRow[] }>(`/api/booth/agents?election_id=${electionId}`),
    ]).then(([b, a]) => {
      setBooths(b.booths)
      setAgents(a.agents)
    })
  }, [electionId])

  const createElection = async () => {
    try {
      await fetchApiJson('/api/booth/elections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(elForm),
      })
      toast.success('Election created')
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const setStatus = async (id: string, status: Election['status']) => {
    try {
      await fetchApiJson(`/api/booth/elections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      toast.success(`Election ${status}`)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const createBooth = async () => {
    try {
      await fetchApiJson('/api/booth/booths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          election_id: electionId,
          part_no: Number(boothForm.part_no),
          section: boothForm.section ? Number(boothForm.section) : null,
          name: boothForm.name || null,
          location: boothForm.location || null,
        }),
      })
      toast.success('Booth created')
      setBoothForm({ part_no: '', section: '', name: '', location: '' })
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const assignAgent = async () => {
    try {
      await fetchApiJson('/api/booth/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentForm),
      })
      toast.success('Agent assigned')
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const assignLeaderUser = async () => {
    try {
      await fetchApiJson('/api/field/leaders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leaderForm),
      })
      toast.success('Field user linked')
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  return (
    <div>
      <PageHeader title="Booth config" description="Open or close poll day, assign booth agents and field team leaders." />

      <section className="mb-6 rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 font-semibold">Elections</h2>
        <div className="mb-3 grid gap-2 sm:grid-cols-4">
          <input className="h-11 rounded-xl border border-line px-3" placeholder="Name" value={elForm.name} onChange={(e) => setElForm({ ...elForm, name: e.target.value })} />
          <input className="h-11 rounded-xl border border-line px-3" type="date" value={elForm.poll_date} onChange={(e) => setElForm({ ...elForm, poll_date: e.target.value })} />
          <select className="h-11 rounded-xl border border-line px-3" value={elForm.status} onChange={(e) => setElForm({ ...elForm, status: e.target.value as Election['status'] })}>
            <option value="draft">draft</option>
            <option value="open">open</option>
            <option value="closed">closed</option>
          </select>
          <button type="button" className="h-11 rounded-xl bg-brand-500 font-semibold text-white" onClick={() => void createElection()}>Create</button>
        </div>
        <div className="space-y-2">
          {elections.map((el) => (
            <div key={el.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
              <button type="button" className={`text-left ${electionId === el.id ? 'font-semibold text-brand-700' : ''}`} onClick={() => setElectionId(el.id)}>
                {el.name} · {el.poll_date} · {el.status}
              </button>
              <div className="flex gap-2">
                <button type="button" className="h-9 rounded-lg border px-3 text-sm" onClick={() => void setStatus(el.id, 'open')}>Open</button>
                <button type="button" className="h-9 rounded-lg border px-3 text-sm" onClick={() => void setStatus(el.id, 'closed')}>Close</button>
                <button type="button" className="h-9 rounded-lg border px-3 text-sm" onClick={() => void setStatus(el.id, 'draft')}>Draft</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 font-semibold">Booths</h2>
        <div className="mb-3 grid gap-2 sm:grid-cols-5">
          <input className="h-11 rounded-xl border px-3" placeholder="Part no" value={boothForm.part_no} onChange={(e) => setBoothForm({ ...boothForm, part_no: e.target.value })} />
          <input className="h-11 rounded-xl border px-3" placeholder="Section" value={boothForm.section} onChange={(e) => setBoothForm({ ...boothForm, section: e.target.value })} />
          <input className="h-11 rounded-xl border px-3" placeholder="Name" value={boothForm.name} onChange={(e) => setBoothForm({ ...boothForm, name: e.target.value })} />
          <input className="h-11 rounded-xl border px-3" placeholder="Location" value={boothForm.location} onChange={(e) => setBoothForm({ ...boothForm, location: e.target.value })} />
          <button type="button" className="h-11 rounded-xl bg-brand-500 font-semibold text-white" onClick={() => void createBooth()}>Add booth</button>
        </div>
        <ul className="text-sm">
          {booths.map((b) => (
            <li key={b.id} className="border-t border-line py-2">
              {b.name || 'Booth'} · Part {b.part_no} {b.section != null ? `· Sec ${b.section}` : ''} {b.location ? `· ${b.location}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-6 rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 font-semibold">Booth agents</h2>
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <select className="h-11 rounded-xl border px-3" value={agentForm.booth_id} onChange={(e) => setAgentForm({ ...agentForm, booth_id: e.target.value })}>
            <option value="">Booth</option>
            {booths.map((b) => (
              <option key={b.id} value={b.id}>{b.name || `Part ${b.part_no}`}</option>
            ))}
          </select>
          <select className="h-11 rounded-xl border px-3" value={agentForm.user_id} onChange={(e) => setAgentForm({ ...agentForm, user_id: e.target.value })}>
            <option value="">User</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
            ))}
          </select>
          <button type="button" className="h-11 rounded-xl bg-brand-500 font-semibold text-white" onClick={() => void assignAgent()}>Assign</button>
        </div>
        <ul className="text-sm">
          {agents.map((a) => (
            <li key={a.id} className="border-t border-line py-2">{a.full_name || a.email}</li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 font-semibold">Field team-leader logins</h2>
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <select className="h-11 rounded-xl border px-3" value={leaderForm.team_leader_id} onChange={(e) => setLeaderForm({ ...leaderForm, team_leader_id: e.target.value })}>
            <option value="">Team leader</option>
            {leaders.map((l) => (
              <option key={l.id} value={l.id}>{l.display_name || l.voter_name || l.id}</option>
            ))}
          </select>
          <select className="h-11 rounded-xl border px-3" value={leaderForm.user_id} onChange={(e) => setLeaderForm({ ...leaderForm, user_id: e.target.value })}>
            <option value="">User</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
            ))}
          </select>
          <button type="button" className="h-11 rounded-xl bg-brand-500 font-semibold text-white" onClick={() => void assignLeaderUser()}>Link</button>
        </div>
        <ul className="text-sm">
          {links.map((row) => (
            <li key={row.id} className="border-t border-line py-2">
              {row.full_name || row.email} → {row.leader_name}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
