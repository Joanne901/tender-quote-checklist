-- 詢價確認表：Supabase 資料庫設定
-- 用法：Supabase 專案 → SQL Editor → New query → 貼上全部 → 把最下面的 Email 改成你的 → Run

-- 1) 團隊成員（只有名單內的 Email 登入後能看、能改資料）
create table if not exists public.members (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where email = lower(auth.jwt() ->> 'email'));
$$;

-- 2) 案件
create table if not exists public.projects (
  id text primary key,
  position integer not null default 0,
  name text not null default '',
  deadline text not null default '',
  days integer not null default 3 check (days between 1 and 30),
  title text,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- 2b) 案件流程：領標、拆標單（stages）；各分類的拆圖說、拆規範（category_tasks）
alter table public.projects add column if not exists stages jsonb not null default '{}'::jsonb;
alter table public.projects add column if not exists category_tasks jsonb not null default '{}'::jsonb;
alter table public.projects add column if not exists warranty_years integer check (warranty_years between 0 and 50);

-- 3) 廠商（每一列就是一間廠商在某個案件裡的進度）
create table if not exists public.vendors (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  position integer not null default 0,
  name text not null,
  category text not null default '',
  contact text not null default '',
  phone text not null default '',
  email text not null default '',
  note text not null default '',
  no_quote boolean not null default false,
  dates jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists vendors_project_idx on public.vendors(project_id);

-- 4) 廠商資料簿（記住的聯絡資料，輸入名稱自動帶入）
create table if not exists public.vendor_book (
  key text primary key,
  position integer not null default 0,
  profile jsonb not null,
  updated_at timestamptz not null default now()
);

-- 5) 權限：只有成員能讀寫
alter table public.members enable row level security;
alter table public.projects enable row level security;
alter table public.vendors enable row level security;
alter table public.vendor_book enable row level security;

drop policy if exists "members read" on public.members;
drop policy if exists "members manage" on public.members;
create policy "members read" on public.members for select to authenticated using (public.is_member());
create policy "members manage" on public.members for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "team projects" on public.projects;
create policy "team projects" on public.projects for all to authenticated using (public.is_member()) with check (public.is_member());
drop policy if exists "team vendors" on public.vendors;
create policy "team vendors" on public.vendors for all to authenticated using (public.is_member()) with check (public.is_member());
drop policy if exists "team vendor book" on public.vendor_book;
create policy "team vendor book" on public.vendor_book for all to authenticated using (public.is_member()) with check (public.is_member());

-- 5b) 明確授權給「已登入」角色（不依賴專案的自動開放設定；未登入者完全沒有權限）
revoke all on public.members, public.projects, public.vendors, public.vendor_book from anon;
grant select, insert, update, delete on public.members, public.projects, public.vendors, public.vendor_book to authenticated;
revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- 6) 即時同步：有人勾選，其他人畫面馬上更新
do $$ begin
  begin alter publication supabase_realtime add table public.projects; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.vendors; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.vendor_book; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
end $$;
alter table public.vendors replica identity full;
alter table public.projects replica identity full;
alter table public.vendor_book replica identity full;

-- 7) 第一位成員：把下面的 Email 改成你自己的（全部小寫），之後其他同事可以在網頁上的「團隊成員」新增
insert into public.members (email) values ('your-email@example.com') on conflict do nothing;
