-- Minors await a guardian e-signature before their membership activates.
alter type membership_status add value if not exists 'pending-waiver';
