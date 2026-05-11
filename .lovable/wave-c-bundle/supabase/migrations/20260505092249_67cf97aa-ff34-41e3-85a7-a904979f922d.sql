REVOKE ALL ON public.page_quality FROM anon, authenticated;
REVOKE ALL ON public.template_quality_breakdown FROM anon, authenticated;
REVOKE ALL ON public.site_issues FROM anon, authenticated;
ALTER VIEW public.page_quality SET (security_invoker = true);
ALTER VIEW public.template_quality_breakdown SET (security_invoker = true);
ALTER VIEW public.site_issues SET (security_invoker = true);