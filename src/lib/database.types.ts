export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          id: string
          person_id: string | null
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          id: string
          person_id?: string | null
          status?: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          id?: string
          person_id?: string | null
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_invites_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_invites_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      cart_items: {
        Row: {
          amount: number
          club_id: string | null
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["invoice_item_kind"]
          label: string
          person_id: string | null
          prior_reg_snapshot: Json | null
          ref_event_id: string | null
          ref_line_type: string | null
          ref_reg_ids: string[] | null
          ref_season_id: string | null
          ref_type: string | null
          ref_user_id: string | null
        }
        Insert: {
          amount?: number
          club_id?: string | null
          created_at?: string
          id: string
          kind: Database["public"]["Enums"]["invoice_item_kind"]
          label: string
          person_id?: string | null
          prior_reg_snapshot?: Json | null
          ref_event_id?: string | null
          ref_line_type?: string | null
          ref_reg_ids?: string[] | null
          ref_season_id?: string | null
          ref_type?: string | null
          ref_user_id?: string | null
        }
        Update: {
          amount?: number
          club_id?: string | null
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["invoice_item_kind"]
          label?: string
          person_id?: string | null
          prior_reg_snapshot?: Json | null
          ref_event_id?: string | null
          ref_line_type?: string | null
          ref_reg_ids?: string[] | null
          ref_season_id?: string | null
          ref_type?: string | null
          ref_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cart_items_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_ref_user_id_fkey"
            columns: ["ref_user_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_ref_user_id_fkey"
            columns: ["ref_user_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      club_managers: {
        Row: {
          club_id: string
          person_id: string
        }
        Insert: {
          club_id: string
          person_id: string
        }
        Update: {
          club_id?: string
          person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_managers_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_managers_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_managers_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      club_memberships: {
        Row: {
          club_id: string
          created_at: string
          granted_by_admin: boolean
          id: string
          purchased_by: string | null
          season_id: string
          status: string
        }
        Insert: {
          club_id: string
          created_at?: string
          granted_by_admin?: boolean
          id?: string
          purchased_by?: string | null
          season_id: string
          status?: string
        }
        Update: {
          club_id?: string
          created_at?: string
          granted_by_admin?: boolean
          id?: string
          purchased_by?: string | null
          season_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_memberships_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_memberships_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      club_requests: {
        Row: {
          created_at: string
          created_club_id: string | null
          decided_at: string | null
          decided_by: string | null
          id: string
          note: string
          proposed_name: string
          region: string | null
          requester_person_id: string | null
          short_name: string
          state: string | null
          status: string
        }
        Insert: {
          created_at?: string
          created_club_id?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          note?: string
          proposed_name: string
          region?: string | null
          requester_person_id?: string | null
          short_name?: string
          state?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          created_club_id?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          note?: string
          proposed_name?: string
          region?: string | null
          requester_person_id?: string | null
          short_name?: string
          state?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_requests_created_club_id_fkey"
            columns: ["created_club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_requests_requester_person_id_fkey"
            columns: ["requester_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_requests_requester_person_id_fkey"
            columns: ["requester_person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      clubs: {
        Row: {
          access: string
          allow_club_pay: boolean
          created_at: string
          email: string | null
          id: string
          name: string
          region: string | null
          short_name: string
          state: string | null
        }
        Insert: {
          access?: string
          allow_club_pay?: boolean
          created_at?: string
          email?: string | null
          id: string
          name: string
          region?: string | null
          short_name: string
          state?: string | null
        }
        Update: {
          access?: string
          allow_club_pay?: boolean
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          region?: string | null
          short_name?: string
          state?: string | null
        }
        Relationships: []
      }
      comm_log: {
        Row: {
          body: string | null
          channel: string
          cost_estimate: number | null
          encoding: string | null
          error: string | null
          failed_count: number | null
          id: string
          is_test: boolean
          recipient_count: number
          recipients: Json | null
          segments: number | null
          sender_person_id: string | null
          sender_user_id: string
          sent_at: string
          sent_count: number | null
          subject: string | null
        }
        Insert: {
          body?: string | null
          channel: string
          cost_estimate?: number | null
          encoding?: string | null
          error?: string | null
          failed_count?: number | null
          id?: string
          is_test?: boolean
          recipient_count?: number
          recipients?: Json | null
          segments?: number | null
          sender_person_id?: string | null
          sender_user_id?: string
          sent_at?: string
          sent_count?: number | null
          subject?: string | null
        }
        Update: {
          body?: string | null
          channel?: string
          cost_estimate?: number | null
          encoding?: string | null
          error?: string | null
          failed_count?: number | null
          id?: string
          is_test?: boolean
          recipient_count?: number
          recipients?: Json | null
          segments?: number | null
          sender_person_id?: string | null
          sender_user_id?: string
          sent_at?: string
          sent_count?: number | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comm_log_sender_person_id_fkey"
            columns: ["sender_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comm_log_sender_person_id_fkey"
            columns: ["sender_person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          amount_off: number | null
          applies_to: string
          applies_to_event_id: string | null
          code: string
          ends_at: string | null
          max_uses: number | null
          pct_off: number | null
          restricted_to_person_id: string | null
          starts_at: string | null
          used_count: number
        }
        Insert: {
          amount_off?: number | null
          applies_to?: string
          applies_to_event_id?: string | null
          code: string
          ends_at?: string | null
          max_uses?: number | null
          pct_off?: number | null
          restricted_to_person_id?: string | null
          starts_at?: string | null
          used_count?: number
        }
        Update: {
          amount_off?: number | null
          applies_to?: string
          applies_to_event_id?: string | null
          code?: string
          ends_at?: string | null
          max_uses?: number | null
          pct_off?: number | null
          restricted_to_person_id?: string | null
          starts_at?: string | null
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "coupons_applies_to_event_id_fkey"
            columns: ["applies_to_event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupons_restricted_to_person_id_fkey"
            columns: ["restricted_to_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupons_restricted_to_person_id_fkey"
            columns: ["restricted_to_person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      error_logs: {
        Row: {
          app_version: string | null
          auth_user_id: string | null
          context: string | null
          created_at: string
          detail: Json | null
          email: string | null
          id: string
          message: string
          person_id: string | null
          stack: string | null
          url: string | null
          user_agent: string | null
        }
        Insert: {
          app_version?: string | null
          auth_user_id?: string | null
          context?: string | null
          created_at?: string
          detail?: Json | null
          email?: string | null
          id?: string
          message: string
          person_id?: string | null
          stack?: string | null
          url?: string | null
          user_agent?: string | null
        }
        Update: {
          app_version?: string | null
          auth_user_id?: string | null
          context?: string | null
          created_at?: string
          detail?: Json | null
          email?: string | null
          id?: string
          message?: string
          person_id?: string | null
          stack?: string | null
          url?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      event_admins: {
        Row: {
          created_at: string
          email: string
          event_id: string
          granted_by: string | null
          id: string
          name: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          event_id: string
          granted_by?: string | null
          id: string
          name?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          event_id?: string
          granted_by?: string | null
          id?: string
          name?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_admins_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_sessions: {
        Row: {
          date: string | null
          discipline: Database["public"]["Enums"]["discipline"]
          event_id: string
          id: string
          level_ids: string[]
          name: string
          phase: string | null
          sort_order: number
          time: string | null
        }
        Insert: {
          date?: string | null
          discipline: Database["public"]["Enums"]["discipline"]
          event_id: string
          id: string
          level_ids?: string[]
          name: string
          phase?: string | null
          sort_order?: number
          time?: string | null
        }
        Update: {
          date?: string | null
          discipline?: Database["public"]["Enums"]["discipline"]
          event_id?: string
          id?: string
          level_ids?: string[]
          name?: string
          phase?: string | null
          sort_order?: number
          time?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meet_sessions_meet_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          age_calc_at: string | null
          banner_addon: Json | null
          banquet: Json | null
          camp_config: Json | null
          capacity: Json | null
          change_fee: Json | null
          city: string | null
          confirmation_email: Json | null
          country: string | null
          created_at: string
          director: Json | null
          disciplines: Database["public"]["Enums"]["discipline"][]
          end_date: string | null
          entry_fee: number
          event_type: string
          host_club_id: string | null
          hotel_link: string | null
          id: string
          kind: Database["public"]["Enums"]["meet_kind"]
          last_date_to_edit: string | null
          late_reg: Json | null
          name: string
          nationals_config: Json | null
          owner: Json | null
          owner_checklist: Json | null
          private_reg_code: string | null
          reg_closes: string | null
          reg_opens: string | null
          sanction_id: string | null
          second_discipline_fee: number
          slug: string
          start_date: string | null
          state: string | null
          status: Database["public"]["Enums"]["event_status"]
          street_address: string | null
          timezone: string
          tshirt_addon: Json | null
          venue: string | null
        }
        Insert: {
          age_calc_at?: string | null
          banner_addon?: Json | null
          banquet?: Json | null
          camp_config?: Json | null
          capacity?: Json | null
          change_fee?: Json | null
          city?: string | null
          confirmation_email?: Json | null
          country?: string | null
          created_at?: string
          director?: Json | null
          disciplines?: Database["public"]["Enums"]["discipline"][]
          end_date?: string | null
          entry_fee?: number
          event_type?: string
          host_club_id?: string | null
          hotel_link?: string | null
          id: string
          kind?: Database["public"]["Enums"]["meet_kind"]
          last_date_to_edit?: string | null
          late_reg?: Json | null
          name: string
          nationals_config?: Json | null
          owner?: Json | null
          owner_checklist?: Json | null
          private_reg_code?: string | null
          reg_closes?: string | null
          reg_opens?: string | null
          sanction_id?: string | null
          second_discipline_fee?: number
          slug: string
          start_date?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["event_status"]
          street_address?: string | null
          timezone?: string
          tshirt_addon?: Json | null
          venue?: string | null
        }
        Update: {
          age_calc_at?: string | null
          banner_addon?: Json | null
          banquet?: Json | null
          camp_config?: Json | null
          capacity?: Json | null
          change_fee?: Json | null
          city?: string | null
          confirmation_email?: Json | null
          country?: string | null
          created_at?: string
          director?: Json | null
          disciplines?: Database["public"]["Enums"]["discipline"][]
          end_date?: string | null
          entry_fee?: number
          event_type?: string
          host_club_id?: string | null
          hotel_link?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["meet_kind"]
          last_date_to_edit?: string | null
          late_reg?: Json | null
          name?: string
          nationals_config?: Json | null
          owner?: Json | null
          owner_checklist?: Json | null
          private_reg_code?: string | null
          reg_closes?: string | null
          reg_opens?: string | null
          sanction_id?: string | null
          second_discipline_fee?: number
          slug?: string
          start_date?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["event_status"]
          street_address?: string | null
          timezone?: string
          tshirt_addon?: Json | null
          venue?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meets_host_club_id_fkey"
            columns: ["host_club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          amount: number
          id: string
          invoice_id: string
          kind: Database["public"]["Enums"]["invoice_item_kind"]
          label: string
          ref_event_id: string | null
          ref_line_type: string | null
          ref_reg_ids: string[] | null
          ref_user_id: string | null
          refunded: boolean
        }
        Insert: {
          amount?: number
          id: string
          invoice_id: string
          kind: Database["public"]["Enums"]["invoice_item_kind"]
          label: string
          ref_event_id?: string | null
          ref_line_type?: string | null
          ref_reg_ids?: string[] | null
          ref_user_id?: string | null
          refunded?: boolean
        }
        Update: {
          amount?: number
          id?: string
          invoice_id?: string
          kind?: Database["public"]["Enums"]["invoice_item_kind"]
          label?: string
          ref_event_id?: string | null
          ref_line_type?: string | null
          ref_reg_ids?: string[] | null
          ref_user_id?: string | null
          refunded?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_ref_user_id_fkey"
            columns: ["ref_user_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_ref_user_id_fkey"
            columns: ["ref_user_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          athlete_id: string | null
          club_id: string | null
          coupon_code: string | null
          created_at: string
          id: string
          number: string
          paid_at: string | null
          stripe_fee: number | null
          stripe_payment_intent_id: string | null
        }
        Insert: {
          athlete_id?: string | null
          club_id?: string | null
          coupon_code?: string | null
          created_at?: string
          id: string
          number: string
          paid_at?: string | null
          stripe_fee?: number | null
          stripe_payment_intent_id?: string | null
        }
        Update: {
          athlete_id?: string | null
          club_id?: string | null
          coupon_code?: string | null
          created_at?: string
          id?: string
          number?: string
          paid_at?: string | null
          stripe_fee?: number | null
          stripe_payment_intent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_coupon_code_fkey"
            columns: ["coupon_code"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["code"]
          },
        ]
      }
      levels: {
        Row: {
          discipline: Database["public"]["Enums"]["discipline"]
          id: string
          name: string
          retired: boolean
          sort_order: number
          sv_max: number | null
          vaults: number
        }
        Insert: {
          discipline: Database["public"]["Enums"]["discipline"]
          id: string
          name: string
          retired?: boolean
          sort_order?: number
          sv_max?: number | null
          vaults?: number
        }
        Update: {
          discipline?: Database["public"]["Enums"]["discipline"]
          id?: string
          name?: string
          retired?: boolean
          sort_order?: number
          sv_max?: number | null
          vaults?: number
        }
        Relationships: []
      }
      manager_access_requests: {
        Row: {
          club_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          requester_person_id: string
          status: string
          token: string
        }
        Insert: {
          club_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          requester_person_id: string
          status?: string
          token: string
        }
        Update: {
          club_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          requester_person_id?: string
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_access_requests_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manager_access_requests_requester_person_id_fkey"
            columns: ["requester_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manager_access_requests_requester_person_id_fkey"
            columns: ["requester_person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          activated_by_admin: boolean
          club_cart_pending: boolean
          created_at: string
          id: string
          paid_via: Database["public"]["Enums"]["pay_method"] | null
          person_id: string
          season_id: string
          status: Database["public"]["Enums"]["membership_status"]
          type: string
          waiver_signed_at: string | null
          waiver_signed_by: string | null
        }
        Insert: {
          activated_by_admin?: boolean
          club_cart_pending?: boolean
          created_at?: string
          id: string
          paid_via?: Database["public"]["Enums"]["pay_method"] | null
          person_id: string
          season_id: string
          status?: Database["public"]["Enums"]["membership_status"]
          type?: string
          waiver_signed_at?: string | null
          waiver_signed_by?: string | null
        }
        Update: {
          activated_by_admin?: boolean
          club_cart_pending?: boolean
          created_at?: string
          id?: string
          paid_via?: Database["public"]["Enums"]["pay_method"] | null
          person_id?: string
          season_id?: string
          status?: Database["public"]["Enums"]["membership_status"]
          type?: string
          waiver_signed_at?: string | null
          waiver_signed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memberships_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_subtotal: number | null
          cart_item_ids: string[] | null
          coupon_code: string | null
          created_at: string
          currency: string
          fulfilled_at: string | null
          id: string
          invoice_id: string | null
          lines_snapshot: Json | null
          person_id: string | null
          ref_reg_ids: string[] | null
          ref_season_id: string | null
          ref_type: string | null
          service_fee: number | null
          status: string
          stripe_event_id: string | null
          stripe_fee: number | null
          stripe_payment_intent_id: string | null
          stripe_session_id: string | null
        }
        Insert: {
          amount_subtotal?: number | null
          cart_item_ids?: string[] | null
          coupon_code?: string | null
          created_at?: string
          currency?: string
          fulfilled_at?: string | null
          id?: string
          invoice_id?: string | null
          lines_snapshot?: Json | null
          person_id?: string | null
          ref_reg_ids?: string[] | null
          ref_season_id?: string | null
          ref_type?: string | null
          service_fee?: number | null
          status?: string
          stripe_event_id?: string | null
          stripe_fee?: number | null
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
        }
        Update: {
          amount_subtotal?: number | null
          cart_item_ids?: string[] | null
          coupon_code?: string | null
          created_at?: string
          currency?: string
          fulfilled_at?: string | null
          id?: string
          invoice_id?: string | null
          lines_snapshot?: Json | null
          person_id?: string | null
          ref_reg_ids?: string[] | null
          ref_season_id?: string | null
          ref_type?: string | null
          service_fee?: number | null
          status?: string
          stripe_event_id?: string | null
          stripe_fee?: number | null
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_coupon_code_fkey"
            columns: ["coupon_code"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          achievements: string[]
          auth_user_id: string | null
          country: string | null
          created_at: string
          dietary: string[]
          dietary_notes: string
          dob: string | null
          email: string
          emergency: Json
          first_name: string
          gender: Database["public"]["Enums"]["gender_kind"] | null
          grad_year: number | null
          id: string
          kind: Database["public"]["Enums"]["person_kind"]
          last_name: string
          levels: Json
          main_club_id: string | null
          outside_us: boolean
          phone: string | null
          placement: Json
          roles: Json
          shirt: string | null
          sms_consent: boolean
          sms_consent_at: string | null
          state: string | null
          student_status: Database["public"]["Enums"]["student_status"] | null
          updated_at: string
        }
        Insert: {
          achievements?: string[]
          auth_user_id?: string | null
          country?: string | null
          created_at?: string
          dietary?: string[]
          dietary_notes?: string
          dob?: string | null
          email: string
          emergency?: Json
          first_name: string
          gender?: Database["public"]["Enums"]["gender_kind"] | null
          grad_year?: number | null
          id: string
          kind?: Database["public"]["Enums"]["person_kind"]
          last_name: string
          levels?: Json
          main_club_id?: string | null
          outside_us?: boolean
          phone?: string | null
          placement?: Json
          roles?: Json
          shirt?: string | null
          sms_consent?: boolean
          sms_consent_at?: string | null
          state?: string | null
          student_status?: Database["public"]["Enums"]["student_status"] | null
          updated_at?: string
        }
        Update: {
          achievements?: string[]
          auth_user_id?: string | null
          country?: string | null
          created_at?: string
          dietary?: string[]
          dietary_notes?: string
          dob?: string | null
          email?: string
          emergency?: Json
          first_name?: string
          gender?: Database["public"]["Enums"]["gender_kind"] | null
          grad_year?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["person_kind"]
          last_name?: string
          levels?: Json
          main_club_id?: string | null
          outside_us?: boolean
          phone?: string | null
          placement?: Json
          roles?: Json
          shirt?: string | null
          sms_consent?: boolean
          sms_consent_at?: string | null
          state?: string | null
          student_status?: Database["public"]["Enums"]["student_status"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "people_main_club_id_fkey"
            columns: ["main_club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
      person_alt_clubs: {
        Row: {
          club_id: string
          person_id: string
        }
        Insert: {
          club_id: string
          person_id: string
        }
        Update: {
          club_id?: string
          person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_alt_clubs_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_alt_clubs_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_alt_clubs_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      regional_rep_regions: {
        Row: {
          region: string
          user_id: string
        }
        Insert: {
          region: string
          user_id: string
        }
        Update: {
          region?: string
          user_id?: string
        }
        Relationships: []
      }
      regions: {
        Row: {
          region: string
          state: string
        }
        Insert: {
          region: string
          state: string
        }
        Update: {
          region?: string
          state?: string
        }
        Relationships: []
      }
      registrations: {
        Row: {
          apparatus: string[]
          apparatus_levels: Json | null
          athlete_id: string
          camp_survey: Json | null
          club_id: string | null
          created_at: string
          discipline: Database["public"]["Enums"]["discipline"]
          event_id: string
          id: string
          keep_listed: boolean
          level_id: string | null
          paid: boolean
          partner_athlete_id: string | null
          refund_requested: boolean
          refunded: boolean
          session_id: string | null
          squad_id: string | null
          updated_pending: boolean
        }
        Insert: {
          apparatus?: string[]
          apparatus_levels?: Json | null
          athlete_id: string
          camp_survey?: Json | null
          club_id?: string | null
          created_at?: string
          discipline: Database["public"]["Enums"]["discipline"]
          event_id: string
          id: string
          keep_listed?: boolean
          level_id?: string | null
          paid?: boolean
          partner_athlete_id?: string | null
          refund_requested?: boolean
          refunded?: boolean
          session_id?: string | null
          squad_id?: string | null
          updated_pending?: boolean
        }
        Update: {
          apparatus?: string[]
          apparatus_levels?: Json | null
          athlete_id?: string
          camp_survey?: Json | null
          club_id?: string | null
          created_at?: string
          discipline?: Database["public"]["Enums"]["discipline"]
          event_id?: string
          id?: string
          keep_listed?: boolean
          level_id?: string | null
          paid?: boolean
          partner_athlete_id?: string | null
          refund_requested?: boolean
          refunded?: boolean
          session_id?: string | null
          squad_id?: string | null
          updated_pending?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "registrations_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_level_id_fkey"
            columns: ["level_id"]
            isOneToOne: false
            referencedRelation: "levels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_meet_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_partner_athlete_id_fkey"
            columns: ["partner_athlete_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_partner_athlete_id_fkey"
            columns: ["partner_athlete_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "event_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_squad_id_fkey"
            columns: ["squad_id"]
            isOneToOne: false
            referencedRelation: "squads"
            referencedColumns: ["id"]
          },
        ]
      }
      sanction_requests: {
        Row: {
          created_event_id: string | null
          deadline_at: string | null
          decided_at: string | null
          event_kind: string
          host_club_id: string | null
          id: string
          payload: Json
          requester_person_id: string | null
          sanction_id: string | null
          status: string
          submitted_at: string | null
        }
        Insert: {
          created_event_id?: string | null
          deadline_at?: string | null
          decided_at?: string | null
          event_kind?: string
          host_club_id?: string | null
          id: string
          payload?: Json
          requester_person_id?: string | null
          sanction_id?: string | null
          status?: string
          submitted_at?: string | null
        }
        Update: {
          created_event_id?: string | null
          deadline_at?: string | null
          decided_at?: string | null
          event_kind?: string
          host_club_id?: string | null
          id?: string
          payload?: Json
          requester_person_id?: string | null
          sanction_id?: string | null
          status?: string
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sanction_requests_created_meet_id_fkey"
            columns: ["created_event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sanction_requests_host_club_id_fkey"
            columns: ["host_club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sanction_requests_requester_person_id_fkey"
            columns: ["requester_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sanction_requests_requester_person_id_fkey"
            columns: ["requester_person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      sanction_votes: {
        Row: {
          comment: string | null
          id: string
          request_id: string
          vote: string
          voted_at: string
          voter_user_id: string
        }
        Insert: {
          comment?: string | null
          id: string
          request_id: string
          vote: string
          voted_at?: string
          voter_user_id: string
        }
        Update: {
          comment?: string | null
          id?: string
          request_id?: string
          vote?: string
          voted_at?: string
          voter_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sanction_votes_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "sanction_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      scores: {
        Row: {
          adjust_note: string | null
          adjusted_at: string | null
          apparatus: string
          calc: string | null
          calc_state: Json | null
          deductions: number | null
          e_score: number | null
          entered_at: string
          entered_by: string | null
          event_id: string
          final: number | null
          flashed: boolean
          id: string
          reg_id: string
          scratched: boolean
          session_id: string | null
          source: Database["public"]["Enums"]["score_source"]
          sv: number | null
        }
        Insert: {
          adjust_note?: string | null
          adjusted_at?: string | null
          apparatus: string
          calc?: string | null
          calc_state?: Json | null
          deductions?: number | null
          e_score?: number | null
          entered_at?: string
          entered_by?: string | null
          event_id: string
          final?: number | null
          flashed?: boolean
          id: string
          reg_id: string
          scratched?: boolean
          session_id?: string | null
          source?: Database["public"]["Enums"]["score_source"]
          sv?: number | null
        }
        Update: {
          adjust_note?: string | null
          adjusted_at?: string | null
          apparatus?: string
          calc?: string | null
          calc_state?: Json | null
          deductions?: number | null
          e_score?: number | null
          entered_at?: string
          entered_by?: string | null
          event_id?: string
          final?: number | null
          flashed?: boolean
          id?: string
          reg_id?: string
          scratched?: boolean
          session_id?: string | null
          source?: Database["public"]["Enums"]["score_source"]
          sv?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "scores_meet_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scores_reg_id_fkey"
            columns: ["reg_id"]
            isOneToOne: false
            referencedRelation: "registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scores_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "event_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      seasons: {
        Row: {
          active: boolean
          athlete_fee: number
          club_fee: number
          coach_fee: number
          created_at: string
          current: boolean
          ends_on: string
          id: string
          name: string
          starts_on: string
        }
        Insert: {
          active?: boolean
          athlete_fee?: number
          club_fee?: number
          coach_fee?: number
          created_at?: string
          current?: boolean
          ends_on: string
          id: string
          name: string
          starts_on: string
        }
        Update: {
          active?: boolean
          athlete_fee?: number
          club_fee?: number
          coach_fee?: number
          created_at?: string
          current?: boolean
          ends_on?: string
          id?: string
          name?: string
          starts_on?: string
        }
        Relationships: []
      }
      sms_messages: {
        Row: {
          body: string | null
          comm_log_id: string | null
          created_at: string
          direction: string
          error: string | null
          id: string
          phone: string
          status: string | null
          updated_at: string
        }
        Insert: {
          body?: string | null
          comm_log_id?: string | null
          created_at?: string
          direction: string
          error?: string | null
          id: string
          phone: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          body?: string | null
          comm_log_id?: string | null
          created_at?: string
          direction?: string
          error?: string | null
          id?: string
          phone?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_messages_comm_log_id_fkey"
            columns: ["comm_log_id"]
            isOneToOne: false
            referencedRelation: "comm_log"
            referencedColumns: ["id"]
          },
        ]
      }
      squads: {
        Row: {
          holding: boolean
          id: string
          name: string
          session_id: string
          sort_order: number
          start_event: number
        }
        Insert: {
          holding?: boolean
          id: string
          name: string
          session_id: string
          sort_order?: number
          start_event?: number
        }
        Update: {
          holding?: boolean
          id?: string
          name?: string
          session_id?: string
          sort_order?: number
          start_event?: number
        }
        Relationships: [
          {
            foreignKeyName: "squads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "event_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      waiver_documents: {
        Row: {
          body: string
          content_hash: string
          created_at: string
          created_by: string | null
          id: string
          published: boolean
          season_id: string
          version: number
          waiver_type: string
        }
        Insert: {
          body: string
          content_hash: string
          created_at?: string
          created_by?: string | null
          id?: string
          published?: boolean
          season_id: string
          version: number
          waiver_type: string
        }
        Update: {
          body?: string
          content_hash?: string
          created_at?: string
          created_by?: string | null
          id?: string
          published?: boolean
          season_id?: string
          version?: number
          waiver_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_documents_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_sign_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          guardian_email: string
          id: string
          membership_type: string
          person_id: string
          season_id: string
          signer_role: string
          status: string
          token: string
          waiver_type: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          guardian_email: string
          id?: string
          membership_type: string
          person_id: string
          season_id: string
          signer_role?: string
          status?: string
          token: string
          waiver_type: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          guardian_email?: string
          id?: string
          membership_type?: string
          person_id?: string
          season_id?: string
          signer_role?: string
          status?: string
          token?: string
          waiver_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_sign_requests_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_sign_requests_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_sign_requests_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_signatures: {
        Row: {
          consent: boolean
          content_hash: string
          created_at: string
          id: string
          ip: string | null
          person_id: string
          season_id: string
          signed_at: string
          signer_email: string
          signer_name: string
          signer_relationship: string | null
          signer_role: string
          user_agent: string | null
          waiver_document_id: string
          waiver_type: string
        }
        Insert: {
          consent: boolean
          content_hash: string
          created_at?: string
          id?: string
          ip?: string | null
          person_id: string
          season_id: string
          signed_at?: string
          signer_email: string
          signer_name: string
          signer_relationship?: string | null
          signer_role: string
          user_agent?: string | null
          waiver_document_id: string
          waiver_type: string
        }
        Update: {
          consent?: boolean
          content_hash?: string
          created_at?: string
          id?: string
          ip?: string | null
          person_id?: string
          season_id?: string
          signed_at?: string
          signer_email?: string
          signer_name?: string
          signer_relationship?: string | null
          signer_role?: string
          user_agent?: string | null
          waiver_document_id?: string
          waiver_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_signatures_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_signatures_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "public_competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_signatures_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_signatures_waiver_document_id_fkey"
            columns: ["waiver_document_id"]
            isOneToOne: false
            referencedRelation: "waiver_documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      public_competitors: {
        Row: {
          first_name: string | null
          id: string | null
          last_name: string | null
          main_club_id: string | null
        }
        Insert: {
          first_name?: string | null
          id?: string | null
          last_name?: string | null
          main_club_id?: string | null
        }
        Update: {
          first_name?: string | null
          id?: string | null
          last_name?: string | null
          main_club_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "people_main_club_id_fkey"
            columns: ["main_club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      auth_has_role: {
        Args: { r: Database["public"]["Enums"]["app_role"] }
        Returns: boolean
      }
      decide_manager_access: {
        Args: { p_decider: string; p_decision: string; p_token: string }
        Returns: string
      }
      email_has_account: { Args: { p_email: string }; Returns: boolean }
      get_manager_access_request: {
        Args: { p_token: string }
        Returns: {
          club_name: string
          requester_name: string
          status: string
        }[]
      }
      get_waiver_sign_request: {
        Args: { p_token: string }
        Returns: {
          first_name: string
          guardian_email: string
          last_name: string
          membership_type: string
          person_id: string
          season_id: string
          signer_role: string
          status: string
          waiver_type: string
        }[]
      }
      grant_event_admin: {
        Args: { p_event_id: string; p_email: string }
        Returns: { email: string; name: string | null; user_id: string }[]
      }
      is_admin: { Args: never; Returns: boolean }
      link_or_create_person: {
        Args: { p_first: string; p_last: string }
        Returns: string
      }
      list_sanctioning_team: {
        Args: never
        Returns: { email: string; name: string; user_id: string }[]
      }
      manages_club: { Args: { cid: string }; Returns: boolean }
      my_person_id: { Args: never; Returns: string }
      redeem_coupon: {
        Args: { p_code: string; p_person_id?: string }
        Returns: boolean
      }
      replace_club_managers: {
        Args: { p_club_id: string; p_person_ids: string[] }
        Returns: undefined
      }
      revoke_event_admin: {
        Args: { p_event_id: string; p_user_id: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "club-manager"
        | "athlete"
        | "judge"
        | "meet-host"
        | "spectator"
        | "sanctioning"
        | "regional_rep"
        | "finance_admin"
      discipline: "MAG" | "WAG" | "TNT"
      event_status:
        | "draft"
        | "reg-open"
        | "reg-closed"
        | "in-progress"
        | "complete"
        | "live"
      gender_kind:
        | "Male"
        | "Female"
        | "Non-binary"
        | "Genderfluid"
        | "Agender"
        | "Other"
      invoice_item_kind:
        | "membership"
        | "meet-entry"
        | "banquet"
        | "addon"
        | "donation"
        | "discount"
        | "fee"
      meet_kind: "standard" | "nationals"
      membership_status:
        | "active"
        | "pending-club-payment"
        | "none"
        | "pending-waiver"
      pay_method: "card" | "club" | "comp"
      person_kind: "athlete" | "coach"
      score_source:
        | "manual"
        | "mag-calc"
        | "wag-open-calc"
        | "masters-calc"
        | "wag-sv-calc"
        | "tnt-calc"
      student_status: "Student" | "Non-Student"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "club-manager",
        "athlete",
        "judge",
        "meet-host",
        "spectator",
        "sanctioning",
        "regional_rep",
        "finance_admin",
      ],
      discipline: ["MAG", "WAG", "TNT"],
      event_status: [
        "draft",
        "reg-open",
        "reg-closed",
        "in-progress",
        "complete",
        "live",
      ],
      gender_kind: [
        "Male",
        "Female",
        "Non-binary",
        "Genderfluid",
        "Agender",
        "Other",
      ],
      invoice_item_kind: [
        "membership",
        "meet-entry",
        "banquet",
        "addon",
        "donation",
        "discount",
        "fee",
      ],
      meet_kind: ["standard", "nationals"],
      membership_status: [
        "active",
        "pending-club-payment",
        "none",
        "pending-waiver",
      ],
      pay_method: ["card", "club", "comp"],
      person_kind: ["athlete", "coach"],
      score_source: [
        "manual",
        "mag-calc",
        "wag-open-calc",
        "masters-calc",
        "wag-sv-calc",
        "tnt-calc",
      ],
      student_status: ["Student", "Non-Student"],
    },
  },
} as const
