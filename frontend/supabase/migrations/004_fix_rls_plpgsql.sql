-- Replace sql functions with plpgsql (never inlined, guaranteed RLS bypass)
CREATE OR REPLACE FUNCTION auth_user_project_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT project_id FROM public.project_members WHERE user_id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION auth_user_coordinator_project_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT project_id FROM public.project_members WHERE user_id = auth.uid() AND role = 'coordenador';
END;
$$;

-- Fix projects policy (was still doing direct subquery on project_members)
DROP POLICY IF EXISTS "Members view projects" ON projects;
CREATE POLICY "Members view projects" ON projects FOR SELECT USING (
  id IN (SELECT auth_user_project_ids())
  OR created_by = auth.uid()
);
