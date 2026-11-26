import { familyPresence, presenceLabel } from '../../lib/presence'
import { placeClubLabel } from '../../lib/placeClubs'
import { voterCategoryLabel } from '../../lib/voterCategory'
import type { PlaceClub, Voter } from '../../lib/types'

type BadgeVoter = Pick<Voter, 'presence_status'> & Partial<Pick<Voter, 'voter_category'>>

export function ClassificationBadges({
  members,
  head,
  placeClub,
}: {
  members: BadgeVoter[]
  head: (Pick<Voter, 'presence_status'> & Partial<Pick<Voter, 'voter_category'>>) | null | undefined
  placeClub?: PlaceClub | null
}) {
  const presence = familyPresence(members, head)
  const category = head?.voter_category ?? members[0]?.voter_category ?? null
  const presenceText = presenceLabel(presence)
  return (
    <>
      {presenceText ? (
        <span className="inline-flex h-5 items-center rounded-full border border-teal-200 bg-teal-50 px-2 text-[11px] font-semibold text-teal-700">
          {presenceText}
        </span>
      ) : null}
      {placeClub ? (
        <span className="inline-flex h-5 items-center rounded-full border border-violet-200 bg-violet-50 px-2 text-[11px] font-semibold text-violet-700">
          {placeClubLabel(placeClub)}
        </span>
      ) : null}
      {category ? (
        <span className="inline-flex h-5 items-center rounded-full border border-brand-200 bg-brand-50 px-2 text-[11px] font-semibold text-brand-700">
          {voterCategoryLabel(category)}
        </span>
      ) : null}
    </>
  )
}
