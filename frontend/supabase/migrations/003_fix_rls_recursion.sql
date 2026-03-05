-- Fix: infinite recursion in RLS policies for project_members
-- SECURITY DEFINER functions bypass RLS, breaking the self-referencing cycle.

-- ========= Helper functions =========
CREATE OR REPLACE FUNCTION auth_user_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION auth_user_coordinator_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT project_id FROM public.project_members WHERE user_id = auth.uid() AND role = 'coordenador'
$$;

-- ========= project_members =========
DROP POLICY IF EXISTS "Members view members" ON project_members;
DROP POLICY IF EXISTS "Coordinators manage members" ON project_members;

CREATE POLICY "Members view members" ON project_members FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
);
CREATE POLICY "Coordinators manage members" ON project_members FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
);

-- ========= documents =========
DROP POLICY IF EXISTS "Members view documents" ON documents;
DROP POLICY IF EXISTS "Coordinators manage documents" ON documents;

CREATE POLICY "Members view documents" ON documents FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Coordinators manage documents" ON documents FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- ========= assignments =========
DROP POLICY IF EXISTS "Members view assignments" ON assignments;
DROP POLICY IF EXISTS "Coordinators manage assignments" ON assignments;

CREATE POLICY "Members view assignments" ON assignments FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Coordinators manage assignments" ON assignments FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- ========= responses =========
DROP POLICY IF EXISTS "Members view responses" ON responses;
DROP POLICY IF EXISTS "Users manage own responses" ON responses;

CREATE POLICY "Members view responses" ON responses FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Users manage own responses" ON responses FOR ALL USING (
  respondent_id = auth.uid()
  OR project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- ========= reviews =========
DROP POLICY IF EXISTS "Members view reviews" ON reviews;
DROP POLICY IF EXISTS "Reviewers manage reviews" ON reviews;

CREATE POLICY "Members view reviews" ON reviews FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Reviewers manage reviews" ON reviews FOR ALL USING (
  reviewer_id = auth.uid()
  OR project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);

-- ========= question_meta =========
DROP POLICY IF EXISTS "Members view question_meta" ON question_meta;
DROP POLICY IF EXISTS "Coordinators manage question_meta" ON question_meta;

CREATE POLICY "Members view question_meta" ON question_meta FOR SELECT USING (
  project_id IN (SELECT auth_user_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
CREATE POLICY "Coordinators manage question_meta" ON question_meta FOR ALL USING (
  project_id IN (SELECT auth_user_coordinator_project_ids())
  OR project_id IN (SELECT id FROM projects WHERE created_by = auth.uid())
);
