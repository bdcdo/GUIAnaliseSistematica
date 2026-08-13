# Database Schema

## Tabelas

### profiles
```sql
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  first_name  TEXT,
  last_name   TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

### projects
```sql
CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  pydantic_code   TEXT,
  pydantic_hash   TEXT,
  pydantic_fields JSONB,
  prompt_template TEXT,
  llm_provider    TEXT DEFAULT 'google_genai',
  llm_model       TEXT DEFAULT 'gemini-3.7-flash',
  llm_kwargs      JSONB DEFAULT '{"temperature": 1.0, "thinking_level": "medium"}',
  resolution_rule              TEXT DEFAULT 'majority',
  min_responses_for_comparison INTEGER DEFAULT 2,
  allow_researcher_review      BOOLEAN DEFAULT false
);
```

**pydantic_fields** formato:
```json
[
  {"name": "q1_1_tratamento_sus", "type": "single", "options": ["Sim", "Não"], "description": "1.1 - O parecer menciona tratamento pelo SUS?"},
  {"name": "q2_4_quais_agencias", "type": "multi", "options": ["FDA (EUA)", "EMA (União Europeia)"], "description": "2.4 - Quais agências?"},
  {"name": "q1_2_alternativa", "type": "text", "options": null, "description": "1.2 - Qual alternativa terapêutica?"}
]
```

### project_members
```sql
CREATE TABLE project_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('coordenador', 'pesquisador')),
  UNIQUE(project_id, user_id)
);
```

### documents
```sql
CREATE TABLE documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  external_id TEXT,
  title       TEXT,
  text        TEXT NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_documents_project ON documents(project_id);
```

### assignments
```sql
CREATE TABLE assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pendente' CHECK (status IN ('pendente', 'em_andamento', 'concluido')),
  UNIQUE(document_id, user_id)
);
CREATE INDEX idx_assignments_user ON assignments(project_id, user_id);
```

### responses
```sql
CREATE TABLE responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
  document_id     UUID REFERENCES documents(id) ON DELETE CASCADE,
  respondent_id   UUID REFERENCES profiles(id),
  respondent_type TEXT NOT NULL CHECK (respondent_type IN ('humano', 'llm')),
  respondent_name TEXT,
  answers         JSONB NOT NULL,
  justifications  JSONB,
  is_latest      BOOLEAN DEFAULT true,
  pydantic_hash   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_responses_document ON responses(project_id, document_id);
CREATE INDEX idx_responses_type ON responses(project_id, respondent_type);
```

### reviews
```sql
CREATE TABLE reviews (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID REFERENCES projects(id) ON DELETE CASCADE,
  document_id        UUID REFERENCES documents(id) ON DELETE CASCADE,
  field_name         TEXT NOT NULL,
  reviewer_id        UUID REFERENCES profiles(id),
  verdict            TEXT NOT NULL,
  chosen_response_id UUID REFERENCES responses(id),
  comment            TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, document_id, field_name, reviewer_id)
);
CREATE INDEX idx_reviews_document ON reviews(project_id, document_id);
```

### question_meta
```sql
CREATE TABLE question_meta (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  field_name  TEXT NOT NULL,
  priority    TEXT DEFAULT 'MEDIA' CHECK (priority IN ('ALTA', 'MEDIA', 'BAIXA')),
  UNIQUE(project_id, field_name)
);
```

## Row Level Security

```sql
-- profiles: usuario so ve o proprio
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own profile" ON profiles FOR ALL USING (auth.uid() = id);

-- projects: so membros veem
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view projects" ON projects FOR SELECT USING (
  id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  OR created_by = auth.uid()
);
CREATE POLICY "Creator manages projects" ON projects FOR ALL USING (created_by = auth.uid());

-- project_members: membros veem, coordenadores gerenciam
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members view members" ON project_members FOR SELECT USING (
  project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
);
CREATE POLICY "Coordinators manage members" ON project_members FOR ALL USING (
  project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid() AND role = 'coordenador'
  )
);

-- Demais tabelas: SELECT para membros, ALL para coordenadores (mesmo padrao)
```

## Queries Importantes

### Campos divergentes (comparacao)
```sql
WITH response_answers AS (
  SELECT r.document_id, r.respondent_name, r.respondent_type, r.id as response_id,
    r.is_latest, r.justifications, key as field_name, value as answer
  FROM responses r, jsonb_each_text(r.answers)
  WHERE r.project_id = $1 AND r.document_id = $2
),
field_stats AS (
  SELECT field_name, COUNT(DISTINCT answer) as distinct_answers, COUNT(*) as total_responses
  FROM response_answers
  WHERE is_latest = true OR respondent_type = 'humano'
  GROUP BY field_name
)
SELECT field_name FROM field_stats
WHERE distinct_answers > 1 AND total_responses >= $3;
```
