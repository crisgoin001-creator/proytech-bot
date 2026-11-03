-- ProyTech Bot — esquema de base de datos (pegar en Supabase > SQL Editor > Run)
create table if not exists leads (
  tel text primary key,
  nombre text,
  linea text,
  origen text,
  etapa text default 'nuevo',
  resumen text,
  pendiente int,
  llamada_sugerida boolean default false,
  seguimientos int default 0,
  ultimo_cliente timestamptz default now(),
  proximo_seguimiento timestamptz,
  creado timestamptz default now(),
  actualizado timestamptz default now()
);
create table if not exists mensajes (
  id bigserial primary key,
  tel text not null references leads(tel) on delete cascade,
  rol text not null check (rol in ('user','assistant')),
  contenido text not null,
  creado timestamptz default now()
);
create index if not exists mensajes_tel_idx on mensajes(tel, id desc);
create table if not exists consultas (
  id bigserial primary key,
  tel text not null,
  consulta text,
  borrador text,
  estado text default 'abierta',
  creado timestamptz default now()
);
create table if not exists datos_confirmados (
  id bigserial primary key,
  consulta text,
  indicacion text,
  creado timestamptz default now()
);
-- Seguridad: solo el servidor (service_role) accede; nadie desde internet.
alter table leads enable row level security;
alter table mensajes enable row level security;
alter table consultas enable row level security;
alter table datos_confirmados enable row level security;

-- v3.1: pausa del bot cuando Christian toma el control
alter table leads add column if not exists pausado_hasta timestamptz;

-- v3.2: citar consultas aunque el servidor se reinicie
alter table consultas add column if not exists wamid text;
create index if not exists consultas_wamid_idx on consultas(wamid);
