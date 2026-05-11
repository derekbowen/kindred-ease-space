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
      amenities: {
        Row: {
          created_at: string
          description: string | null
          hero_image_url: string | null
          icon: string | null
          id: string
          is_published: boolean
          name: string
          seo_description: string | null
          seo_title: string | null
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          icon?: string | null
          id?: string
          is_published?: boolean
          name: string
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          icon?: string | null
          id?: string
          is_published?: boolean
          name?: string
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      billing_config: {
        Row: {
          credit_pack_price_id: string | null
          credits_per_pack: number
          id: number
          pro_monthly_credits: number
          pro_price_id: string | null
          scale_monthly_credits: number
          scale_price_id: string | null
          starter_monthly_credits: number
          starter_price_id: string | null
          updated_at: string
        }
        Insert: {
          credit_pack_price_id?: string | null
          credits_per_pack?: number
          id?: number
          pro_monthly_credits?: number
          pro_price_id?: string | null
          scale_monthly_credits?: number
          scale_price_id?: string | null
          starter_monthly_credits?: number
          starter_price_id?: string | null
          updated_at?: string
        }
        Update: {
          credit_pack_price_id?: string | null
          credits_per_pack?: number
          id?: number
          pro_monthly_credits?: number
          pro_price_id?: string | null
          scale_monthly_credits?: number
          scale_price_id?: string | null
          starter_monthly_credits?: number
          starter_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      blog_posts: {
        Row: {
          author: string | null
          content: string | null
          cover_image_url: string | null
          created_at: string
          excerpt: string | null
          id: string
          is_published: boolean
          published_at: string | null
          seo_description: string | null
          seo_title: string | null
          slug: string
          title: string
          topic: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          author?: string | null
          content?: string | null
          cover_image_url?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          is_published?: boolean
          published_at?: string | null
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          title: string
          topic?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          author?: string | null
          content?: string | null
          cover_image_url?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          is_published?: boolean
          published_at?: string | null
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          title?: string
          topic?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_posts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      cities: {
        Row: {
          created_at: string
          description: string | null
          hero_image_url: string | null
          id: string
          is_published: boolean
          latitude: number | null
          longitude: number | null
          name: string
          seo_description: string | null
          seo_title: string | null
          slug: string
          state: string
          state_code: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          id?: string
          is_published?: boolean
          latitude?: number | null
          longitude?: number | null
          name: string
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          state: string
          state_code: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          id?: string
          is_published?: boolean
          latitude?: number | null
          longitude?: number | null
          name?: string
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          state?: string
          state_code?: string
          updated_at?: string
        }
        Relationships: []
      }
      cities_hero_backfill_log: {
        Row: {
          city_slug: string
          error: string | null
          id: string
          image_url: string | null
          ran_at: string
          source_url: string | null
          status: string
          workspace_id: string
        }
        Insert: {
          city_slug: string
          error?: string | null
          id?: string
          image_url?: string | null
          ran_at?: string
          source_url?: string | null
          status: string
          workspace_id: string
        }
        Update: {
          city_slug?: string
          error?: string | null
          id?: string
          image_url?: string | null
          ran_at?: string
          source_url?: string | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cities_hero_backfill_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      city_link_clicks: {
        Row: {
          clicked_at: string
          country: string | null
          from_city_slug: string | null
          id: string
          referrer_path: string | null
          region: string | null
          to_city_slug: string
          user_agent: string | null
          visitor_hash: string | null
          workspace_id: string
        }
        Insert: {
          clicked_at?: string
          country?: string | null
          from_city_slug?: string | null
          id?: string
          referrer_path?: string | null
          region?: string | null
          to_city_slug: string
          user_agent?: string | null
          visitor_hash?: string | null
          workspace_id: string
        }
        Update: {
          clicked_at?: string
          country?: string | null
          from_city_slug?: string | null
          id?: string
          referrer_path?: string | null
          region?: string | null
          to_city_slug?: string
          user_agent?: string | null
          visitor_hash?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "city_link_clicks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      competitor_host_matches: {
        Row: {
          admin_notes: string | null
          candidate_business_name: string | null
          candidate_email: string | null
          candidate_evidence: string | null
          candidate_name: string | null
          candidate_phone: string | null
          candidate_social_url: string | null
          candidate_source: string | null
          candidate_website: string | null
          competitor_url: string
          competitor_url_id: string
          created_at: string
          domain: string | null
          enriched_at: string | null
          enriched_emails: Json | null
          enriched_phones: Json | null
          enriched_socials: Json | null
          enriched_tier: string | null
          enrichment_cost_usd: number | null
          host_city: string | null
          host_first_name: string | null
          host_state: string | null
          id: string
          match_confidence: number
          property_address: string | null
          revenue_signal_notes: string | null
          revenue_signal_score: number | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          admin_notes?: string | null
          candidate_business_name?: string | null
          candidate_email?: string | null
          candidate_evidence?: string | null
          candidate_name?: string | null
          candidate_phone?: string | null
          candidate_social_url?: string | null
          candidate_source?: string | null
          candidate_website?: string | null
          competitor_url: string
          competitor_url_id: string
          created_at?: string
          domain?: string | null
          enriched_at?: string | null
          enriched_emails?: Json | null
          enriched_phones?: Json | null
          enriched_socials?: Json | null
          enriched_tier?: string | null
          enrichment_cost_usd?: number | null
          host_city?: string | null
          host_first_name?: string | null
          host_state?: string | null
          id?: string
          match_confidence?: number
          property_address?: string | null
          revenue_signal_notes?: string | null
          revenue_signal_score?: number | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          admin_notes?: string | null
          candidate_business_name?: string | null
          candidate_email?: string | null
          candidate_evidence?: string | null
          candidate_name?: string | null
          candidate_phone?: string | null
          candidate_social_url?: string | null
          candidate_source?: string | null
          candidate_website?: string | null
          competitor_url?: string
          competitor_url_id?: string
          created_at?: string
          domain?: string | null
          enriched_at?: string | null
          enriched_emails?: Json | null
          enriched_phones?: Json | null
          enriched_socials?: Json | null
          enriched_tier?: string | null
          enrichment_cost_usd?: number | null
          host_city?: string | null
          host_first_name?: string | null
          host_state?: string | null
          id?: string
          match_confidence?: number
          property_address?: string | null
          revenue_signal_notes?: string | null
          revenue_signal_score?: number | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_host_matches_competitor_url_id_fkey"
            columns: ["competitor_url_id"]
            isOneToOne: false
            referencedRelation: "competitor_urls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitor_host_matches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      competitor_pages: {
        Row: {
          created_at: string
          domain: string | null
          h1: string | null
          headings: Json | null
          id: string
          last_scraped_at: string | null
          markdown: string | null
          meta_description: string | null
          notes: string | null
          title: string | null
          updated_at: string
          url: string
          word_count: number | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          domain?: string | null
          h1?: string | null
          headings?: Json | null
          id?: string
          last_scraped_at?: string | null
          markdown?: string | null
          meta_description?: string | null
          notes?: string | null
          title?: string | null
          updated_at?: string
          url: string
          word_count?: number | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          domain?: string | null
          h1?: string | null
          headings?: Json | null
          id?: string
          last_scraped_at?: string | null
          markdown?: string | null
          meta_description?: string | null
          notes?: string | null
          title?: string | null
          updated_at?: string
          url?: string
          word_count?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_pages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      competitor_sites: {
        Row: {
          created_at: string
          domain: string
          id: string
          is_active: boolean
          label: string | null
          last_checked_at: string | null
          last_url_count: number
          sitemap_url: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          id?: string
          is_active?: boolean
          label?: string | null
          last_checked_at?: string | null
          last_url_count?: number
          sitemap_url: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          id?: string
          is_active?: boolean
          label?: string | null
          last_checked_at?: string | null
          last_url_count?: number
          sitemap_url?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_sites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      competitor_urls: {
        Row: {
          acknowledged: boolean
          first_seen_at: string
          id: string
          last_seen_at: string
          scraped_at: string | null
          site_id: string
          title: string | null
          url: string
          word_count: number | null
          workspace_id: string
        }
        Insert: {
          acknowledged?: boolean
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          scraped_at?: string | null
          site_id: string
          title?: string | null
          url: string
          word_count?: number | null
          workspace_id: string
        }
        Update: {
          acknowledged?: boolean
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          scraped_at?: string | null
          site_id?: string
          title?: string | null
          url?: string
          word_count?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_urls_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "competitor_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitor_urls_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      content_404_log: {
        Row: {
          first_seen_at: string
          hit_count: number
          id: string
          last_seen_at: string
          referrer: string | null
          resolution_notes: string | null
          resolved_at: string | null
          slug: string | null
          url_path: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          first_seen_at?: string
          hit_count?: number
          id?: string
          last_seen_at?: string
          referrer?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          slug?: string | null
          url_path: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          first_seen_at?: string
          hit_count?: number
          id?: string
          last_seen_at?: string
          referrer?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          slug?: string | null
          url_path?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_404_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      content_pages: {
        Row: {
          body_markdown: string | null
          category: string
          content: string | null
          created_at: string
          description: string | null
          gsc_clicks: number | null
          gsc_impressions: number | null
          gsc_position: number | null
          gsc_updated_at: string | null
          hero_image_url: string | null
          hreflang_group: string | null
          id: string
          in_sitemap: boolean
          legacy_slugs: string[] | null
          locale: string
          migrated_at: string | null
          priority: number
          raw_html: string | null
          redirect_to: string | null
          scraped_at: string | null
          seo_description: string | null
          seo_title: string | null
          sitemap_source: string | null
          slug: string | null
          source_url: string | null
          status: string
          template_type: string | null
          title: string | null
          updated_at: string
          url_path: string | null
          workspace_id: string
        }
        Insert: {
          body_markdown?: string | null
          category?: string
          content?: string | null
          created_at?: string
          description?: string | null
          gsc_clicks?: number | null
          gsc_impressions?: number | null
          gsc_position?: number | null
          gsc_updated_at?: string | null
          hero_image_url?: string | null
          hreflang_group?: string | null
          id?: string
          in_sitemap?: boolean
          legacy_slugs?: string[] | null
          locale?: string
          migrated_at?: string | null
          priority?: number
          raw_html?: string | null
          redirect_to?: string | null
          scraped_at?: string | null
          seo_description?: string | null
          seo_title?: string | null
          sitemap_source?: string | null
          slug?: string | null
          source_url?: string | null
          status?: string
          template_type?: string | null
          title?: string | null
          updated_at?: string
          url_path?: string | null
          workspace_id: string
        }
        Update: {
          body_markdown?: string | null
          category?: string
          content?: string | null
          created_at?: string
          description?: string | null
          gsc_clicks?: number | null
          gsc_impressions?: number | null
          gsc_position?: number | null
          gsc_updated_at?: string | null
          hero_image_url?: string | null
          hreflang_group?: string | null
          id?: string
          in_sitemap?: boolean
          legacy_slugs?: string[] | null
          locale?: string
          migrated_at?: string | null
          priority?: number
          raw_html?: string | null
          redirect_to?: string | null
          scraped_at?: string | null
          seo_description?: string | null
          seo_title?: string | null
          sitemap_source?: string | null
          slug?: string | null
          source_url?: string | null
          status?: string
          template_type?: string | null
          title?: string | null
          updated_at?: string
          url_path?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_pages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      content_plan: {
        Row: {
          city: string | null
          created_at: string
          generated_at: string | null
          generated_page_slug: string | null
          h1: string | null
          id: string
          internal_links: string | null
          last_error: string | null
          meta_description: string | null
          meta_title: string | null
          notes: string | null
          population_2024: number | null
          primary_keyword: string | null
          priority_score: number | null
          priority_tier: string | null
          schema_suggestions: string | null
          search_intent: string | null
          slug: string
          source_type: string
          source_url: string | null
          state: string | null
          state_code: string | null
          status: string
          supporting_keywords: string | null
          uniqueness_angle: string | null
          updated_at: string
          warm_climate: boolean | null
          workspace_id: string
        }
        Insert: {
          city?: string | null
          created_at?: string
          generated_at?: string | null
          generated_page_slug?: string | null
          h1?: string | null
          id?: string
          internal_links?: string | null
          last_error?: string | null
          meta_description?: string | null
          meta_title?: string | null
          notes?: string | null
          population_2024?: number | null
          primary_keyword?: string | null
          priority_score?: number | null
          priority_tier?: string | null
          schema_suggestions?: string | null
          search_intent?: string | null
          slug: string
          source_type?: string
          source_url?: string | null
          state?: string | null
          state_code?: string | null
          status?: string
          supporting_keywords?: string | null
          uniqueness_angle?: string | null
          updated_at?: string
          warm_climate?: boolean | null
          workspace_id: string
        }
        Update: {
          city?: string | null
          created_at?: string
          generated_at?: string | null
          generated_page_slug?: string | null
          h1?: string | null
          id?: string
          internal_links?: string | null
          last_error?: string | null
          meta_description?: string | null
          meta_title?: string | null
          notes?: string | null
          population_2024?: number | null
          primary_keyword?: string | null
          priority_score?: number | null
          priority_tier?: string | null
          schema_suggestions?: string | null
          search_intent?: string | null
          slug?: string
          source_type?: string
          source_url?: string | null
          state?: string | null
          state_code?: string | null
          status?: string
          supporting_keywords?: string | null
          uniqueness_angle?: string | null
          updated_at?: string
          warm_climate?: boolean | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_plan_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      course_completions: {
        Row: {
          certificate_uid: string
          completed_at: string
          course_slug: string
          course_title: string
          id: string
          learner_name: string
          revoke_reason: string | null
          revoked_at: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          certificate_uid?: string
          completed_at?: string
          course_slug: string
          course_title: string
          id?: string
          learner_name: string
          revoke_reason?: string | null
          revoked_at?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          certificate_uid?: string
          completed_at?: string
          course_slug?: string
          course_title?: string
          id?: string
          learner_name?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_completions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      course_enrollments: {
        Row: {
          course_slug: string
          enrolled_at: string
          id: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          course_slug: string
          enrolled_at?: string
          id?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          course_slug?: string
          enrolled_at?: string
          id?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_enrollments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      course_progress: {
        Row: {
          completed_at: string | null
          course_slug: string
          created_at: string
          id: string
          last_activity_at: string
          progress_pct: number
          started_at: string
          total_seconds_spent: number
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          course_slug: string
          created_at?: string
          id?: string
          last_activity_at?: string
          progress_pct?: number
          started_at?: string
          total_seconds_spent?: number
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          course_slug?: string
          created_at?: string
          id?: string
          last_activity_at?: string
          progress_pct?: number
          started_at?: string
          total_seconds_spent?: number
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_progress_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      course_progress_events: {
        Row: {
          course_slug: string
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          course_slug: string
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          user_id: string
          workspace_id: string
        }
        Update: {
          course_slug?: string
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_progress_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          category: string
          cover_image_url: string | null
          created_at: string
          description: string | null
          duration_minutes: number | null
          embed_url: string | null
          excerpt: string | null
          external_detail_url: string | null
          id: string
          is_featured: boolean
          is_published: boolean
          language: string
          level: string | null
          long_form_content: Json | null
          published_at: string | null
          seo_description: string | null
          seo_title: string | null
          slug: string
          subtitle: string | null
          tier: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          category?: string
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          duration_minutes?: number | null
          embed_url?: string | null
          excerpt?: string | null
          external_detail_url?: string | null
          id?: string
          is_featured?: boolean
          is_published?: boolean
          language?: string
          level?: string | null
          long_form_content?: Json | null
          published_at?: string | null
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          subtitle?: string | null
          tier?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          category?: string
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          duration_minutes?: number | null
          embed_url?: string | null
          excerpt?: string | null
          external_detail_url?: string | null
          id?: string
          is_featured?: boolean
          is_published?: boolean
          language?: string
          level?: string | null
          long_form_content?: Json | null
          published_at?: string | null
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          subtitle?: string | null
          tier?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "courses_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_balances: {
        Row: {
          balance: number
          created_at: string
          cycle_resets_at: string | null
          lifetime_granted: number
          lifetime_spent: number
          monthly_allowance: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          cycle_resets_at?: string | null
          lifetime_granted?: number
          lifetime_spent?: number
          monthly_allowance?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          cycle_resets_at?: string | null
          lifetime_granted?: number
          lifetime_spent?: number
          monthly_allowance?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_balances_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_ledger: {
        Row: {
          ai_model: string | null
          created_at: string
          delta: number
          id: string
          metadata: Json | null
          reason: string
          ref_id: string | null
          ref_type: string | null
          workspace_id: string
        }
        Insert: {
          ai_model?: string | null
          created_at?: string
          delta: number
          id?: string
          metadata?: Json | null
          reason: string
          ref_id?: string | null
          ref_type?: string | null
          workspace_id: string
        }
        Update: {
          ai_model?: string | null
          created_at?: string
          delta?: number
          id?: string
          metadata?: Json | null
          reason?: string
          ref_id?: string | null
          ref_type?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_ledger_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_purchases: {
        Row: {
          amount_cents: number
          created_at: string
          credits: number
          currency: string
          id: string
          status: string
          stripe_payment_intent_id: string | null
          stripe_session_id: string | null
          workspace_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          credits: number
          currency?: string
          id?: string
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          workspace_id: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          credits?: number
          currency?: string
          id?: string
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_purchases_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          canceled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          last_event_at: string | null
          last_event_id: string | null
          plan: Database["public"]["Enums"]["app_plan"]
          raw: Json | null
          status: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id: string
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          trial_ends_at: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          last_event_at?: string | null
          last_event_id?: string | null
          plan: Database["public"]["Enums"]["app_plan"]
          raw?: Json | null
          status: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id: string
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          last_event_at?: string | null
          last_event_id?: string | null
          plan?: Database["public"]["Enums"]["app_plan"]
          raw?: Json | null
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id?: string
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_subscriptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_branding: {
        Row: {
          created_at: string
          footer_text: string | null
          logo_url: string | null
          primary_color: string
          primary_text_color: string
          sender_name: string
          site_name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          footer_text?: string | null
          logo_url?: string | null
          primary_color?: string
          primary_text_color?: string
          sender_name?: string
          site_name?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          footer_text?: string | null
          logo_url?: string | null
          primary_color?: string
          primary_text_color?: string
          sender_name?: string
          site_name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_branding_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_send_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      enriched_contacts: {
        Row: {
          cache_key: string
          cost_usd: number
          emails: Json
          expires_at: string
          fetched_at: string
          full_name: string | null
          id: string
          phones: Json
          property_address: string | null
          property_city: string | null
          property_state: string | null
          property_zip: string | null
          raw_response: Json | null
          social_profiles: Json
          source_tier: string
          workspace_id: string
        }
        Insert: {
          cache_key: string
          cost_usd?: number
          emails?: Json
          expires_at?: string
          fetched_at?: string
          full_name?: string | null
          id?: string
          phones?: Json
          property_address?: string | null
          property_city?: string | null
          property_state?: string | null
          property_zip?: string | null
          raw_response?: Json | null
          social_profiles?: Json
          source_tier: string
          workspace_id: string
        }
        Update: {
          cache_key?: string
          cost_usd?: number
          emails?: Json
          expires_at?: string
          fetched_at?: string
          full_name?: string | null
          id?: string
          phones?: Json
          property_address?: string | null
          property_city?: string | null
          property_state?: string | null
          property_zip?: string | null
          raw_response?: Json | null
          social_profiles?: Json
          source_tier?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "enriched_contacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      enrichment_spend_log: {
        Row: {
          cost_usd: number
          created_at: string
          id: string
          match_id: string | null
          outcome: string
          provider: string
          spend_date: string
          workspace_id: string
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          id?: string
          match_id?: string | null
          outcome: string
          provider: string
          spend_date?: string
          workspace_id: string
        }
        Update: {
          cost_usd?: number
          created_at?: string
          id?: string
          match_id?: string | null
          outcome?: string
          provider?: string
          spend_date?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "enrichment_spend_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      external_api_queue: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          endpoint: string | null
          error: string | null
          id: string
          max_attempts: number
          payload: Json
          priority: number
          provider: string
          response: Json | null
          scheduled_at: string
          started_at: string | null
          status: Database["public"]["Enums"]["external_api_queue_status"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          endpoint?: string | null
          error?: string | null
          id?: string
          max_attempts?: number
          payload?: Json
          priority?: number
          provider: string
          response?: Json | null
          scheduled_at?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["external_api_queue_status"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          endpoint?: string | null
          error?: string | null
          id?: string
          max_attempts?: number
          payload?: Json
          priority?: number
          provider?: string
          response?: Json | null
          scheduled_at?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["external_api_queue_status"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "external_api_queue_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_requests: {
        Row: {
          city: string | null
          created_at: string
          email: string
          id: string
          latitude: number | null
          longitude: number | null
          name: string | null
          referrer_path: string | null
          region: string | null
          request_text: string
          status: string
          updated_at: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          city?: string | null
          created_at?: string
          email: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          name?: string | null
          referrer_path?: string | null
          region?: string | null
          request_text: string
          status?: string
          updated_at?: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          city?: string | null
          created_at?: string
          email?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          name?: string | null
          referrer_path?: string | null
          region?: string | null
          request_text?: string
          status?: string
          updated_at?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feature_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      gsc_query_data: {
        Row: {
          captured_at: string
          clicks: number
          created_at: string
          ctr: number | null
          id: string
          impressions: number
          position: number | null
          query: string
          url_path: string
          workspace_id: string
        }
        Insert: {
          captured_at?: string
          clicks?: number
          created_at?: string
          ctr?: number | null
          id?: string
          impressions?: number
          position?: number | null
          query: string
          url_path: string
          workspace_id: string
        }
        Update: {
          captured_at?: string
          clicks?: number
          created_at?: string
          ctr?: number | null
          id?: string
          impressions?: number
          position?: number | null
          query?: string
          url_path?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gsc_query_data_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      help_articles: {
        Row: {
          category_slug: string
          content: string | null
          created_at: string
          excerpt: string | null
          id: string
          is_popular: boolean
          is_published: boolean
          seo_description: string | null
          seo_title: string | null
          slug: string
          sort_order: number
          title: string
          updated_at: string
          view_count: number
          workspace_id: string
        }
        Insert: {
          category_slug: string
          content?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          is_popular?: boolean
          is_published?: boolean
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          sort_order?: number
          title: string
          updated_at?: string
          view_count?: number
          workspace_id: string
        }
        Update: {
          category_slug?: string
          content?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          is_popular?: boolean
          is_published?: boolean
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          sort_order?: number
          title?: string
          updated_at?: string
          view_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_articles_category_slug_fkey"
            columns: ["category_slug"]
            isOneToOne: false
            referencedRelation: "help_categories"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "help_articles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      help_categories: {
        Row: {
          created_at: string
          description: string | null
          hero_image_url: string | null
          icon: string | null
          id: string
          is_published: boolean
          name: string
          seo_description: string | null
          seo_title: string | null
          slug: string
          sort_order: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          icon?: string | null
          id?: string
          is_published?: boolean
          name: string
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          sort_order?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          icon?: string | null
          id?: string
          is_published?: boolean
          name?: string
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          sort_order?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_categories_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      host_match_false_positives: {
        Row: {
          candidate_business_name: string | null
          candidate_email: string | null
          candidate_name: string | null
          candidate_phone: string | null
          candidate_source: string | null
          candidate_website: string | null
          competitor_url: string | null
          created_at: string
          domain: string | null
          host_city: string | null
          host_first_name: string | null
          host_state: string | null
          id: string
          match_confidence: number | null
          match_id: string | null
          reason: string | null
          reported_by: string | null
          workspace_id: string
        }
        Insert: {
          candidate_business_name?: string | null
          candidate_email?: string | null
          candidate_name?: string | null
          candidate_phone?: string | null
          candidate_source?: string | null
          candidate_website?: string | null
          competitor_url?: string | null
          created_at?: string
          domain?: string | null
          host_city?: string | null
          host_first_name?: string | null
          host_state?: string | null
          id?: string
          match_confidence?: number | null
          match_id?: string | null
          reason?: string | null
          reported_by?: string | null
          workspace_id: string
        }
        Update: {
          candidate_business_name?: string | null
          candidate_email?: string | null
          candidate_name?: string | null
          candidate_phone?: string | null
          candidate_source?: string | null
          candidate_website?: string | null
          competitor_url?: string | null
          created_at?: string
          domain?: string | null
          host_city?: string | null
          host_first_name?: string | null
          host_state?: string | null
          id?: string
          match_confidence?: number | null
          match_id?: string | null
          reason?: string | null
          reported_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "host_match_false_positives_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      host_profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          cached_at: string
          city_id: string | null
          display_name: string
          is_published: boolean
          joined_at: string | null
          listing_count: number
          updated_at: string
          uuid: string
          workspace_id: string
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          cached_at?: string
          city_id?: string | null
          display_name: string
          is_published?: boolean
          joined_at?: string | null
          listing_count?: number
          updated_at?: string
          uuid: string
          workspace_id: string
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          cached_at?: string
          city_id?: string | null
          display_name?: string
          is_published?: boolean
          joined_at?: string | null
          listing_count?: number
          updated_at?: string
          uuid?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "host_profiles_city_id_fkey"
            columns: ["city_id"]
            isOneToOne: false
            referencedRelation: "cities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "host_profiles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      host_tools: {
        Row: {
          category: string
          created_at: string
          icon: string | null
          id: string
          is_published: boolean
          slug: string
          sort_order: number
          summary: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          category?: string
          created_at?: string
          icon?: string | null
          id?: string
          is_published?: boolean
          slug: string
          sort_order?: number
          summary?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          category?: string
          created_at?: string
          icon?: string | null
          id?: string
          is_published?: boolean
          slug?: string
          sort_order?: number
          summary?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "host_tools_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      internal_link_suggestions: {
        Row: {
          anchor_text: string | null
          created_at: string
          from_url: string
          id: string
          reason: string | null
          score: number
          status: string
          to_url: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          anchor_text?: string | null
          created_at?: string
          from_url: string
          id?: string
          reason?: string | null
          score?: number
          status?: string
          to_url: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          anchor_text?: string | null
          created_at?: string
          from_url?: string
          id?: string
          reason?: string | null
          score?: number
          status?: string
          to_url?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "internal_link_suggestions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_sync_log: {
        Row: {
          created_at: string
          error_message: string | null
          failed_count: number
          finished_at: string | null
          id: string
          inserted_count: number
          started_at: string
          status: string
          total_processed: number
          updated_count: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          inserted_count?: number
          started_at?: string
          status?: string
          total_processed?: number
          updated_count?: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          inserted_count?: number
          started_at?: string
          status?: string
          total_processed?: number
          updated_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listing_sync_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mb_likes: {
        Row: {
          created_at: string
          id: string
          reply_id: string | null
          thread_id: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          reply_id?: string | null
          thread_id?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          reply_id?: string | null
          thread_id?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mb_likes_reply_id_fkey"
            columns: ["reply_id"]
            isOneToOne: false
            referencedRelation: "mb_replies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mb_likes_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "mb_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mb_likes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mb_replies: {
        Row: {
          author_name: string | null
          body: string
          created_at: string
          id: string
          like_count: number
          thread_id: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          author_name?: string | null
          body: string
          created_at?: string
          id?: string
          like_count?: number
          thread_id: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          author_name?: string | null
          body?: string
          created_at?: string
          id?: string
          like_count?: number
          thread_id?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mb_replies_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "mb_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mb_replies_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mb_threads: {
        Row: {
          author_name: string | null
          body: string
          category: string | null
          created_at: string
          id: string
          is_pinned: boolean
          last_activity_at: string
          like_count: number
          reply_count: number
          title: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          author_name?: string | null
          body: string
          category?: string | null
          created_at?: string
          id?: string
          is_pinned?: boolean
          last_activity_at?: string
          like_count?: number
          reply_count?: number
          title: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          author_name?: string | null
          body?: string
          category?: string | null
          created_at?: string
          id?: string
          is_pinned?: boolean
          last_activity_at?: string
          like_count?: number
          reply_count?: number
          title?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mb_threads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      page_audits: {
        Row: {
          audited_at: string
          id: string
          recommendations: Json
          score: number | null
          strengths: Json
          summary: string | null
          url_path: string
          weaknesses: Json
          workspace_id: string
        }
        Insert: {
          audited_at?: string
          id?: string
          recommendations?: Json
          score?: number | null
          strengths?: Json
          summary?: string | null
          url_path: string
          weaknesses?: Json
          workspace_id: string
        }
        Update: {
          audited_at?: string
          id?: string
          recommendations?: Json
          score?: number | null
          strengths?: Json
          summary?: string | null
          url_path?: string
          weaknesses?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_audits_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      pool_waitlist: {
        Row: {
          city: string | null
          created_at: string
          email: string
          id: string
          latitude: number | null
          longitude: number | null
          nearest_miles: number | null
          region: string | null
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          city?: string | null
          created_at?: string
          email: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          nearest_miles?: number | null
          region?: string | null
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          city?: string | null
          created_at?: string
          email?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          nearest_miles?: number | null
          region?: string | null
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pool_waitlist_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          full_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      provider_claims: {
        Row: {
          admin_notes: string | null
          business_email: string | null
          business_phone: string | null
          business_website: string | null
          claimer_email: string
          claimer_name: string
          claimer_phone: string | null
          claimer_role: string | null
          created_at: string
          id: string
          proposed_updates: Json
          provider_id: string
          provider_slug: string
          reviewed_at: string | null
          reviewed_by: string | null
          source_path: string | null
          status: string
          updated_at: string
          user_agent: string | null
          verification_notes: string | null
          workspace_id: string
        }
        Insert: {
          admin_notes?: string | null
          business_email?: string | null
          business_phone?: string | null
          business_website?: string | null
          claimer_email: string
          claimer_name: string
          claimer_phone?: string | null
          claimer_role?: string | null
          created_at?: string
          id?: string
          proposed_updates?: Json
          provider_id: string
          provider_slug: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_path?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          verification_notes?: string | null
          workspace_id: string
        }
        Update: {
          admin_notes?: string | null
          business_email?: string | null
          business_phone?: string | null
          business_website?: string | null
          claimer_email?: string
          claimer_name?: string
          claimer_phone?: string | null
          claimer_role?: string | null
          created_at?: string
          id?: string
          proposed_updates?: Json
          provider_id?: string
          provider_slug?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_path?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          verification_notes?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_claims_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_claims_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_leads: {
        Row: {
          city: string | null
          company: string | null
          created_at: string
          email: string
          id: string
          message: string | null
          name: string
          phone: string | null
          source_path: string | null
          source_provider_slug: string | null
          state_code: string | null
          status: string
          updated_at: string
          user_id: string | null
          website: string | null
          workspace_id: string
        }
        Insert: {
          city?: string | null
          company?: string | null
          created_at?: string
          email: string
          id?: string
          message?: string | null
          name: string
          phone?: string | null
          source_path?: string | null
          source_provider_slug?: string | null
          state_code?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
          website?: string | null
          workspace_id: string
        }
        Update: {
          city?: string | null
          company?: string | null
          created_at?: string
          email?: string
          id?: string
          message?: string | null
          name?: string
          phone?: string | null
          source_path?: string | null
          source_provider_slug?: string | null
          state_code?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
          website?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_leads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_plan_requests: {
        Row: {
          admin_notes: string | null
          amount_usd: number | null
          created_at: string
          id: string
          notes: string | null
          payment_method: string | null
          payment_reference: string | null
          provider_id: string
          provider_slug: string
          requested_plan: string
          requester_email: string
          requester_name: string
          requester_phone: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source_path: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          admin_notes?: string | null
          amount_usd?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          payment_reference?: string | null
          provider_id: string
          provider_slug: string
          requested_plan: string
          requester_email: string
          requester_name: string
          requester_phone?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_path?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          admin_notes?: string | null
          amount_usd?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          payment_reference?: string | null
          provider_id?: string
          provider_slug?: string
          requested_plan?: string
          requester_email?: string
          requester_name?: string
          requester_phone?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_path?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_plan_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_scrape_jobs: {
        Row: {
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          provider_id: string | null
          raw: Json | null
          source_type: string | null
          source_url: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          provider_id?: string | null
          raw?: Json | null
          source_type?: string | null
          source_url: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          provider_id?: string | null
          raw?: Json | null
          source_type?: string | null
          source_url?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_scrape_jobs_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "providers"
            referencedColumns: ["id"]
          },
        ]
      }
      providers: {
        Row: {
          address: string | null
          ai_content_generated_at: string | null
          ai_enriched_at: string | null
          business_type: string | null
          city: string | null
          city_slug: string | null
          claim_status: string
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          description: string | null
          email: string | null
          faq: Json
          featured_until: string | null
          gallery_urls: string[]
          google_category: string | null
          google_cid: string | null
          gsc_clicks: number
          gsc_impressions: number
          gsc_position: number | null
          gsc_updated_at: string | null
          hero_image_url: string | null
          id: string
          is_featured: boolean
          is_published: boolean
          latitude: number | null
          listing_paid_until: string | null
          logo_url: string | null
          long_description: string | null
          longitude: number | null
          name: string
          phone: string | null
          plan: string
          primary_category: string | null
          rating: number | null
          rating_count: number | null
          scraped_at: string | null
          secondary_categories: string[]
          seo_description: string | null
          seo_title: string | null
          services: string[] | null
          slug: string
          source_type: string | null
          source_url: string | null
          state_code: string | null
          submission_notes: string | null
          submission_status: string
          submitter_email: string | null
          updated_at: string
          website_url: string | null
          workspace_id: string
        }
        Insert: {
          address?: string | null
          ai_content_generated_at?: string | null
          ai_enriched_at?: string | null
          business_type?: string | null
          city?: string | null
          city_slug?: string | null
          claim_status?: string
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          description?: string | null
          email?: string | null
          faq?: Json
          featured_until?: string | null
          gallery_urls?: string[]
          google_category?: string | null
          google_cid?: string | null
          gsc_clicks?: number
          gsc_impressions?: number
          gsc_position?: number | null
          gsc_updated_at?: string | null
          hero_image_url?: string | null
          id?: string
          is_featured?: boolean
          is_published?: boolean
          latitude?: number | null
          listing_paid_until?: string | null
          logo_url?: string | null
          long_description?: string | null
          longitude?: number | null
          name: string
          phone?: string | null
          plan?: string
          primary_category?: string | null
          rating?: number | null
          rating_count?: number | null
          scraped_at?: string | null
          secondary_categories?: string[]
          seo_description?: string | null
          seo_title?: string | null
          services?: string[] | null
          slug: string
          source_type?: string | null
          source_url?: string | null
          state_code?: string | null
          submission_notes?: string | null
          submission_status?: string
          submitter_email?: string | null
          updated_at?: string
          website_url?: string | null
          workspace_id: string
        }
        Update: {
          address?: string | null
          ai_content_generated_at?: string | null
          ai_enriched_at?: string | null
          business_type?: string | null
          city?: string | null
          city_slug?: string | null
          claim_status?: string
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          description?: string | null
          email?: string | null
          faq?: Json
          featured_until?: string | null
          gallery_urls?: string[]
          google_category?: string | null
          google_cid?: string | null
          gsc_clicks?: number
          gsc_impressions?: number
          gsc_position?: number | null
          gsc_updated_at?: string | null
          hero_image_url?: string | null
          id?: string
          is_featured?: boolean
          is_published?: boolean
          latitude?: number | null
          listing_paid_until?: string | null
          logo_url?: string | null
          long_description?: string | null
          longitude?: number | null
          name?: string
          phone?: string | null
          plan?: string
          primary_category?: string | null
          rating?: number | null
          rating_count?: number | null
          scraped_at?: string | null
          secondary_categories?: string[]
          seo_description?: string | null
          seo_title?: string | null
          services?: string[] | null
          slug?: string
          source_type?: string | null
          source_url?: string | null
          state_code?: string | null
          submission_notes?: string | null
          submission_status?: string
          submitter_email?: string | null
          updated_at?: string
          website_url?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "providers_primary_category_fkey"
            columns: ["primary_category"]
            isOneToOne: false
            referencedRelation: "service_categories"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "providers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      public_pool_cities: {
        Row: {
          city_name: string
          city_slug: string
          created_at: string
          hero_image_url: string | null
          id: string
          intro: string | null
          is_published: boolean
          state_slug: string
          updated_at: string
        }
        Insert: {
          city_name: string
          city_slug: string
          created_at?: string
          hero_image_url?: string | null
          id?: string
          intro?: string | null
          is_published?: boolean
          state_slug: string
          updated_at?: string
        }
        Update: {
          city_name?: string
          city_slug?: string
          created_at?: string
          hero_image_url?: string | null
          id?: string
          intro?: string | null
          is_published?: boolean
          state_slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_pool_cities_state_slug_fkey"
            columns: ["state_slug"]
            isOneToOne: false
            referencedRelation: "public_pool_states"
            referencedColumns: ["state_slug"]
          },
        ]
      }
      public_pool_states: {
        Row: {
          created_at: string
          hero_image_url: string | null
          intro: string | null
          is_published: boolean
          state_code: string
          state_name: string
          state_slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          hero_image_url?: string | null
          intro?: string | null
          is_published?: boolean
          state_code: string
          state_name: string
          state_slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          hero_image_url?: string | null
          intro?: string | null
          is_published?: boolean
          state_code?: string
          state_name?: string
          state_slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      public_pools: {
        Row: {
          address: string | null
          amenities: string[] | null
          city_slug: string
          contact: Json | null
          created_at: string
          description: string | null
          hero_image_url: string | null
          hours: Json | null
          id: string
          is_published: boolean
          latitude: number | null
          longitude: number | null
          pool_name: string
          pool_slug: string
          state_slug: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          amenities?: string[] | null
          city_slug: string
          contact?: Json | null
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          hours?: Json | null
          id?: string
          is_published?: boolean
          latitude?: number | null
          longitude?: number | null
          pool_name: string
          pool_slug: string
          state_slug: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          amenities?: string[] | null
          city_slug?: string
          contact?: Json | null
          created_at?: string
          description?: string | null
          hero_image_url?: string | null
          hours?: Json | null
          id?: string
          is_published?: boolean
          latitude?: number | null
          longitude?: number | null
          pool_name?: string
          pool_slug?: string
          state_slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_pools_state_slug_city_slug_fkey"
            columns: ["state_slug", "city_slug"]
            isOneToOne: false
            referencedRelation: "public_pool_cities"
            referencedColumns: ["state_slug", "city_slug"]
          },
        ]
      }
      seo_fix_jobs: {
        Row: {
          attempts: number
          batch_id: string | null
          created_at: string
          enqueued_by: string | null
          error: string | null
          finished_at: string | null
          id: string
          max_attempts: number
          mode: string
          page_id: string
          result: Json | null
          started_at: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempts?: number
          batch_id?: string | null
          created_at?: string
          enqueued_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          max_attempts?: number
          mode: string
          page_id: string
          result?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempts?: number
          batch_id?: string | null
          created_at?: string
          enqueued_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          max_attempts?: number
          mode?: string
          page_id?: string
          result?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_fix_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seo_overrides: {
        Row: {
          canonical_url: string | null
          created_at: string
          description: string | null
          id: string
          noindex: boolean
          notes: string | null
          og_image_url: string | null
          title: string | null
          updated_at: string
          url_path: string
          workspace_id: string
        }
        Insert: {
          canonical_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          noindex?: boolean
          notes?: string | null
          og_image_url?: string | null
          title?: string | null
          updated_at?: string
          url_path: string
          workspace_id: string
        }
        Update: {
          canonical_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          noindex?: boolean
          notes?: string | null
          og_image_url?: string | null
          title?: string | null
          updated_at?: string
          url_path?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seo_overrides_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      serp_rankings: {
        Row: {
          checked_at: string
          id: string
          keyword_id: string
          position: number | null
          url_found: string | null
          workspace_id: string
        }
        Insert: {
          checked_at?: string
          id?: string
          keyword_id: string
          position?: number | null
          url_found?: string | null
          workspace_id: string
        }
        Update: {
          checked_at?: string
          id?: string
          keyword_id?: string
          position?: number | null
          url_found?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "serp_rankings_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "tracked_keywords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "serp_rankings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      service_categories: {
        Row: {
          created_at: string
          hero_image_url: string | null
          icon: string | null
          id: string
          intro_markdown: string | null
          is_published: boolean
          name: string
          plural_name: string
          seo_description: string | null
          seo_title: string | null
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          hero_image_url?: string | null
          icon?: string | null
          id?: string
          intro_markdown?: string | null
          is_published?: boolean
          name: string
          plural_name: string
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          hero_image_url?: string | null
          icon?: string | null
          id?: string
          intro_markdown?: string | null
          is_published?: boolean
          name?: string
          plural_name?: string
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      site_footer_settings: {
        Row: {
          bottom_text: string | null
          company_links: Json
          contact_email: string | null
          contact_phone: string | null
          contact_phone_hours: string | null
          contact_phone_label: string | null
          explore_links: Json
          host_links: Json
          popular_markets: Json
          socials: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          bottom_text?: string | null
          company_links?: Json
          contact_email?: string | null
          contact_phone?: string | null
          contact_phone_hours?: string | null
          contact_phone_label?: string | null
          explore_links?: Json
          host_links?: Json
          popular_markets?: Json
          socials?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          bottom_text?: string | null
          company_links?: Json
          contact_email?: string | null
          contact_phone?: string | null
          contact_phone_hours?: string | null
          contact_phone_label?: string | null
          explore_links?: Json
          host_links?: Json
          popular_markets?: Json
          socials?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_footer_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      state_pool_regulations: {
        Row: {
          authority_name: string | null
          authority_url: string | null
          compliance_steps: Json
          created_at: string
          enforcement_notes: string | null
          faqs: Json
          id: string
          last_verified_at: string | null
          legality_status: string
          permit_fee_max_usd: number | null
          permit_fee_min_usd: number | null
          permit_name: string | null
          source_urls: string[]
          state_code: string
          state_name: string
          summary: string | null
          updated_at: string
          zoning_summary: string | null
        }
        Insert: {
          authority_name?: string | null
          authority_url?: string | null
          compliance_steps?: Json
          created_at?: string
          enforcement_notes?: string | null
          faqs?: Json
          id?: string
          last_verified_at?: string | null
          legality_status?: string
          permit_fee_max_usd?: number | null
          permit_fee_min_usd?: number | null
          permit_name?: string | null
          source_urls?: string[]
          state_code: string
          state_name: string
          summary?: string | null
          updated_at?: string
          zoning_summary?: string | null
        }
        Update: {
          authority_name?: string | null
          authority_url?: string | null
          compliance_steps?: Json
          created_at?: string
          enforcement_notes?: string | null
          faqs?: Json
          id?: string
          last_verified_at?: string | null
          legality_status?: string
          permit_fee_max_usd?: number | null
          permit_fee_min_usd?: number | null
          permit_name?: string | null
          source_urls?: string[]
          state_code?: string
          state_name?: string
          summary?: string | null
          updated_at?: string
          zoning_summary?: string | null
        }
        Relationships: []
      }
      stripe_customers: {
        Row: {
          created_at: string
          email: string | null
          id: string
          stripe_customer_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          stripe_customer_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          stripe_customer_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_customers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          id: string
          plan_tier: string
          status: string
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan_tier?: string
          status?: string
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan_tier?: string
          status?: string
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppressed_emails_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      synced_listings: {
        Row: {
          address: string | null
          amenities: string[]
          author_id: string | null
          capacity: number | null
          category: string | null
          city: string | null
          city_slug: string | null
          created_at: string
          description: string | null
          id: string
          image_urls: string[]
          is_deleted: boolean
          last_synced_at: string
          latitude: number | null
          longitude: number | null
          metadata: Json
          price_amount: number | null
          price_currency: string | null
          primary_image_url: string | null
          public_data: Json
          sharetribe_id: string
          slug: string
          st_created_at: string | null
          state: string
          state_code: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          address?: string | null
          amenities?: string[]
          author_id?: string | null
          capacity?: number | null
          category?: string | null
          city?: string | null
          city_slug?: string | null
          created_at?: string
          description?: string | null
          id?: string
          image_urls?: string[]
          is_deleted?: boolean
          last_synced_at?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json
          price_amount?: number | null
          price_currency?: string | null
          primary_image_url?: string | null
          public_data?: Json
          sharetribe_id: string
          slug: string
          st_created_at?: string | null
          state?: string
          state_code?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          address?: string | null
          amenities?: string[]
          author_id?: string | null
          capacity?: number | null
          category?: string | null
          city?: string | null
          city_slug?: string | null
          created_at?: string
          description?: string | null
          id?: string
          image_urls?: string[]
          is_deleted?: boolean
          last_synced_at?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json
          price_amount?: number | null
          price_currency?: string | null
          primary_image_url?: string | null
          public_data?: Json
          sharetribe_id?: string
          slug?: string
          st_created_at?: string | null
          state?: string
          state_code?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "synced_listings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tracked_keywords: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          keyword: string
          last_checked_at: string | null
          last_position: number | null
          market: string
          previous_position: number | null
          target_url_path: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          keyword: string
          last_checked_at?: string | null
          last_position?: number | null
          market?: string
          previous_position?: number | null
          target_url_path?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          keyword?: string
          last_checked_at?: string | null
          last_position?: number | null
          market?: string
          previous_position?: number | null
          target_url_path?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracked_keywords_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      workspace_members: {
        Row: {
          created_at: string
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_secrets: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          key_name: string
          updated_at: string
          value: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_name: string
          updated_at?: string
          value: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_name?: string
          updated_at?: string
          value?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_secrets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          brand_color: string | null
          brand_name: string | null
          created_at: string
          current_period_end: string | null
          domain_verified_at: string | null
          id: string
          is_internal: boolean
          logo_url: string | null
          marketplace_domain: string | null
          name: string
          owner_user_id: string | null
          plan: Database["public"]["Enums"]["app_plan"]
          slug: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          brand_color?: string | null
          brand_name?: string | null
          created_at?: string
          current_period_end?: string | null
          domain_verified_at?: string | null
          id?: string
          is_internal?: boolean
          logo_url?: string | null
          marketplace_domain?: string | null
          name: string
          owner_user_id?: string | null
          plan?: Database["public"]["Enums"]["app_plan"]
          slug: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          brand_color?: string | null
          brand_name?: string | null
          created_at?: string
          current_period_end?: string | null
          domain_verified_at?: string | null
          id?: string
          is_internal?: boolean
          logo_url?: string | null
          marketplace_domain?: string | null
          name?: string
          owner_user_id?: string | null
          plan?: Database["public"]["Enums"]["app_plan"]
          slug?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      page_quality: {
        Row: {
          body_markdown: string | null
          created_at: string | null
          id: string | null
          missing_meta: boolean | null
          missing_schema: boolean | null
          no_internal_links: boolean | null
          quality: string | null
          seo_description: string | null
          seo_title: string | null
          slug: string | null
          status: string | null
          template_type: string | null
          title: string | null
          title_is_slug: boolean | null
          updated_at: string | null
          url_path: string | null
          word_count: number | null
        }
        Insert: {
          body_markdown?: string | null
          created_at?: string | null
          id?: string | null
          missing_meta?: never
          missing_schema?: never
          no_internal_links?: never
          quality?: never
          seo_description?: string | null
          seo_title?: string | null
          slug?: string | null
          status?: string | null
          template_type?: string | null
          title?: string | null
          title_is_slug?: never
          updated_at?: string | null
          url_path?: string | null
          word_count?: never
        }
        Update: {
          body_markdown?: string | null
          created_at?: string | null
          id?: string | null
          missing_meta?: never
          missing_schema?: never
          no_internal_links?: never
          quality?: never
          seo_description?: string | null
          seo_title?: string | null
          slug?: string | null
          status?: string | null
          template_type?: string | null
          title?: string | null
          title_is_slug?: never
          updated_at?: string | null
          url_path?: string | null
          word_count?: never
        }
        Relationships: []
      }
      site_issues: {
        Row: {
          empty_published_total: number | null
          missing_meta_published: number | null
          missing_schema_published: number | null
          no_links_published: number | null
          thin_published_total: number | null
          title_is_slug_published: number | null
        }
        Relationships: []
      }
      template_quality_breakdown: {
        Row: {
          avg_words_published: number | null
          oldest_pending: string | null
          pending: number | null
          published: number | null
          published_empty: number | null
          published_healthy: number | null
          published_last_7d: number | null
          published_medium: number | null
          published_thin: number | null
          template_type: string | null
          total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      count_providers_by_category: {
        Args: never
        Returns: {
          n: number
          primary_category: string
        }[]
      }
      current_workspace_id_by_host: { Args: { _host: string }; Returns: string }
      deduct_credits: {
        Args: {
          _ai_model?: string
          _amount: number
          _metadata?: Json
          _reason: string
          _ref_id?: string
          _ref_type?: string
          _workspace_id: string
        }
        Returns: number
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      generate_certificate_uid: { Args: never; Returns: string }
      grant_credits: {
        Args: {
          _amount: number
          _metadata?: Json
          _reason: string
          _ref_id?: string
          _ref_type?: string
          _workspace_id: string
        }
        Returns: number
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_workspace_member: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
      is_workspace_owner: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      nearby_cities_by_distance: {
        Args: { _limit?: number; _slug: string }
        Returns: {
          out_distance_km: number
          out_name: string
          out_slug: string
          out_state: string
          out_state_code: string
        }[]
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      verify_certificate: {
        Args: { _uid: string }
        Returns: {
          certificate_uid: string
          completed_at: string
          course_slug: string
          course_title: string
          learner_name: string
          revoke_reason: string
          revoked_at: string
        }[]
      }
      workspace_for_host: { Args: { _host: string }; Returns: string }
    }
    Enums: {
      app_plan: "starter" | "growth" | "scale" | "enterprise"
      app_role: "admin" | "editor" | "user"
      external_api_queue_status:
        | "pending"
        | "processing"
        | "done"
        | "error"
        | "cancelled"
      subscription_status:
        | "trialing"
        | "active"
        | "past_due"
        | "canceled"
        | "incomplete"
        | "incomplete_expired"
        | "unpaid"
        | "paused"
      workspace_role: "owner" | "editor"
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
      app_plan: ["starter", "growth", "scale", "enterprise"],
      app_role: ["admin", "editor", "user"],
      external_api_queue_status: [
        "pending",
        "processing",
        "done",
        "error",
        "cancelled",
      ],
      subscription_status: [
        "trialing",
        "active",
        "past_due",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "unpaid",
        "paused",
      ],
      workspace_role: ["owner", "editor"],
    },
  },
} as const
