-- Seed the single NAIGC waiver (HTML) as published v1 for the current season.
-- Idempotent: the unique (season_id, waiver_type, version) constraint + ON CONFLICT
-- means re-running is a no-op. Admins replace it by saving a new version in the UI.
with w as (
  select $WAIVER$<h1>NAIGC Risk Assumption and Waiver Form</h1>
  <p><strong>BY SIGNING THIS RISK ASSUMPTION AND WAIVER FORM (“AGREEMENT”), I AM WAIVING CERTAIN LEGAL RIGHTS. MY SIGNATURE BELOW INDICATES THAT I HAVE READ THIS AGREEMENT CAREFULLY AND IN FULL. MY SIGNATURE ALSO INDICATES THAT I UNDERSTAND AND AGREE TO ALL OF ITS TERMS.</strong></p>

  <p>The National Association of Intercollegiate Gymnastics Clubs ("NAIGC") sanctions several competitions and events throughout the 2026–2027 season (July 1, 2026 – June 30, 2027). <strong>This waiver applies to all events sanctioned by the NAIGC in the 2026–2027 season, including Nationals.</strong></p>

  <h2>Readiness to Compete</h2>
  <p>I represent that I am physically and psychologically healthy enough to participate in the Event and do not have any health condition that would impair my ability to safely participate in the Event. I have properly prepared to perform each of the exercises I will attempt at the Event. I have practiced each of the exercises I will attempt at the Event and I have performed those exercises in the past without suffering injury.</p>

  <h2>Waiver and Release of Liability</h2>
  <p>In consideration for being allowed to participate in this Event, I expressly and knowingly acknowledge and agree that:</p>
  <ul>
    <li>My participation in the Event is entirely voluntary;</li>
    <li>I am solely responsible for my actions, conduct, and safety during the Event, and agree to follow all NAIGC rules, regulations, and instructions;</li>
    <li>I am solely responsible for the safekeeping of my personal property; neither the NAIGC nor the venues (hotel, convention center, etc.) are responsible for any lost, stolen or damaged articles left on the premises prior to, during, or following the event;</li>
    <li>I possess all rights necessary, have obtained necessary licenses, have paid all necessary fees, royalties and other consideration therefore which are due for the use of copyrighted works in my performances or exhibitions to the copyright owner, or representative of said copyright owner; I assume full responsibility both in reporting and payment of any music licensing fees that may be required by law; I agree to indemnify NAIGC and the convention center and hold NAIGC harmless from any loss, damage, fine, penalty, claim or other liability including but not limited to claims for copyright infringement and / or royalties, including all legal expenses and fees; neither NAIGC nor the convention center expressly assumes any obligations, implied or otherwise, regarding payment or collection of any such fees or financial obligations;</li>
    <li>There are risks inherent in my participation in the Event because of, but not limited to, the inherently dangerous nature of gymnastics, including risk of serious bodily injury, permanent disability, and/or death. I expressly assume the risk for any injury, including serious injury or death by participating in the Event including injuries not typically associated with gymnastics activities;</li>
    <li>The dangers and risks of participating in the Event, both known and unknown, both as a result of my actions, inactions, or negligence and the actions, inactions, or negligence of another or others--including but not limited to risks relating to equipment or other aspects of gymnastics competition participation over which I have little or no control--may result not only in serious injury or death, but also in a serious impairment of my future abilities to earn a living, to engage in other business, social, and recreational activities, and generally to enjoy life, among other things;</li>
    <li>The NAIGC cannot and does not represent that I will not be harmed during the Event;</li>
    <li>The NAIGC may disclose, or release, personal information for the purpose of medical treatment;</li>
    <li>I will accept medical treatment including emergency medical treatment and medical transportation as deemed necessary by medical personnel and / or NAIGC;</li>
    <li>The NAIGC will not be held responsible for the disclosure or release of personal medical information;</li>
    <li>All bills for medical care and treatment as a result of my participation with the Event will be my responsibility; and</li>
      <li>The NAIGC does not warrant or guarantee in any respect the physical condition of any of the equipment used in connection with this Event; the party signing this agreement agrees not to hold the NAIGC liable for any injury caused by the equipment.</li>
    <li>The NAIGC or its agents may terminate my participation in the Event for non-compliance with the rules, regulations, or instructions of NAIGC or the venues (hotel, convention center, etc.) or their agents, or for any other reason; If found to be non-compliant, I acknowledge that I will be responsible for bearing all costs related to the termination and forfeit any fees I paid for my participation in the Event.</li>
    <li>The NAIGC reserves the right to revoke the registration of any individual found to be listed on the USAG permanently ineligible list at any point.</li>
  </ul>

  <p>On behalf of myself and my heirs and assigns, and all members of my family, I knowingly and voluntarily assume all risks, physically, psychologically, financially and legally which may be incurred from or connected in any manner with my participation in the Event, including but not limited to the risk of serious bodily injury, permanent disability, or death caused by my participation. I understand and agree that by signing below, I waive and forever release NAIGC, its board of directors, officers, agents, and sponsors from all claims, causes of action, or demands of any nature that I may have in the future, whether known or unknown and whether anticipated or unanticipated, for personal injury, death, property or other damage sustained by or to me during or because of my participation in the Event, including damage caused by the negligence of the NAIGC, its board of directors, officers, agents and/or sponsors.</p>

  <h2>Publicity Rights</h2>
  <p>I grant—irrevocably, in perpetuity, and throughout the world—to the NAIGC and Venue(s) permission to record, use, and edit my name, voice, image, likeness, performance, and all biographical information submitted by me related to the Event or taken of me during the Event. I acknowledge that the NAIGC may reproduce, create derivative works, distribute, publicly perform and display, and sell such recordings in any and all formats or media, as well as use such recordings in advertising, marketing, or promoting the NAIGC or its events and programs. I agree that I will not receive compensation for any of the aforementioned uses. The NAIGC will not use my performance for the express or implied endorsement of any third party’s products or services.</p>

  <h2>Text Messaging</h2>
  <p>NAIGC may use group texting services for announcement / informational purposes. By providing my phone number to the NAIGC, I agree to accept standard text messaging costs / fees.</p>

  <h2>Code of Conduct</h2>
  <p>I have read, understood, and agree to abide by the NAIGC Code of Conduct and rules of any host Hotel or Venue. The full text of the NAIGC Code of Conduct can be found <a href="https://naigc.org/wp-content/uploads/Code-of-Conduct.pdf">here</a>. acknowledge and understand that any violation of the NAIGC Code of Conduct or host Hotel or Venue’s rules or policies may result in a final warning and/or termination of access to NAIGC events.
      </p><p>
          By signing below, I expressly agree that this Risk Assumption and Waiver Form shall be governed by and interpreted in accordance with the laws of the State of North Carolina without regard to conflict-of-laws principles. I intend this to be a complete and unconditional release of all liability to the greatest extent allowed by law. If a court holds any part of this Agreement to be unenforceable or against public policy, the offending part of the Agreement shall be construed to be inconsistent with the law but the remaining terms shall remain enforceable.
</p>
<h2>
    Refund Policy
</h2>
<p>
    I have read and understand the <a href="https://naigc.org/wp-content/uploads/NAIGC-Refund-Policy.pdf">NAIGC Refund Policy</a>. This refund policy applies only to events <strong>hosted</strong> by the NAIGC. For all other sanctioned events, the refund policy is at the discretion of the host club.
</p>
<p>
    <strong>BY ELECTRONICALLY SIGNING BELOW, I REPRESENT THAT I HAVE READ, UNDERSTAND, AND VOLUNTARILY CONSENT TO ALL OF THE TERMS OF THIS AGREEMENT.</strong>
</p>
<p>
    Print Name: (must match the name of the current logged-in user as it is entered in the table below)
</p>
<ul>
    <li>I understand that by entering my name below, my signature is being transferred electronically, and I will not challenge the validity of the signature in any legal proceeding in which this document may be offered or used.</li>
<li>For participants over the age of 18, the name entered below <strong>must match the name of the current logged-in user.</strong></li>
    <li>I am at least 18 years of age and have the requisite legal capacity to consent to the terms of this Agreement.</li>
        
        
    
    
</ul><p>
    <strong>Any participant under the age of 18 or otherwise without legal capacity to enter into this contractual Agreement must have a parent or legal guardian enter their name below.</strong>
</p>$WAIVER$::text as body
)
insert into waiver_documents (id, season_id, waiver_type, version, body, content_hash, published, created_at)
select gen_random_uuid(), s.id, 'General', 1, w.body, 'ba50795d896e1608bea8b0a11faf0977be9fd3c9aae80064ab05538417c4b8b3', true, now()
from seasons s, w
where s.current = true
on conflict (season_id, waiver_type, version) do nothing;
