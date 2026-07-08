import { Search, Trash2, Edit3, RefreshCw, FileText, Archive, Clock, User, Brain } from 'lucide-react'
import { useEffect, useState } from 'react'

interface KnowledgeFile {
  file: string
  kind: 'memory' | 'lessons' | 'memory_archive' | 'lessons_archive' | 'search_index' | 'growth'
  size: number
  exists: boolean
}

interface SearchResult {
  file: string
  snippet: string
}

type SubTab = 'memory' | 'lessons' | 'archive' | 'growth'

export function KnowledgeManager() {
  const [subTab, setSubTab] = useState<SubTab>('memory')
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [content, setContent] = useState('')
  const [currentFile, setCurrentFile] = useState('')
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    loadFiles()
  }, [])

  const loadFiles = async () => {
    try {
      const result = await window.ranparty.request<{ items: KnowledgeFile[] }>('knowledge.list', {})
      setFiles(result.items ?? [])
    } catch { /* no-op */ }
  }

  const loadContent = async (file: string) => {
    setLoading(true)
    try {
      const result = await window.ranparty.request<{ content: string }>('knowledge.list', { file })
      setContent(result.content)
      setCurrentFile(file)
      setEditing(false)
    } catch { setMessage('加载失败') }
    finally { setLoading(false) }
  }

  const saveContent = async () => {
    setLoading(true)
    setMessage('')
    try {
      await window.ranparty.request('knowledge.update', { file: currentFile, content: editContent })
      setContent(editContent)
      setEditing(false)
      setMessage('已保存')
      setTimeout(() => setMessage(''), 2000)
    } catch { setMessage('保存失败') }
    finally { setLoading(false) }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setLoading(true)
    try {
      const result = await window.ranparty.request<{ results: SearchResult[] }>('knowledge.search', { query: searchQuery })
      setSearchResults(result.results ?? [])
    } catch { setMessage('搜索失败') }
    finally { setLoading(false) }
  }

  const kindIcon = (kind: string) => {
    switch (kind) {
      case 'memory': return <User size={14} />
      case 'lessons': return <Brain size={14} />
      case 'memory_archive':
      case 'lessons_archive': return <Archive size={14} />
      case 'growth': return <Clock size={14} />
      default: return <FileText size={14} />
    }
  }

  const kindLabel = (kind: string) => {
    switch (kind) {
      case 'memory': return '用户画像'
      case 'lessons': return '经验精华'
      case 'memory_archive': return '偏好归档'
      case 'lessons_archive': return '踩坑归档'
      case 'growth': return '角色成长'
      default: return kind
    }
  }

  const filterFiles = (kind: string) => {
    switch (subTab) {
      case 'memory': return kind === 'memory'
      case 'lessons': return kind === 'lessons'
      case 'archive': return kind === 'memory_archive' || kind === 'lessons_archive'
      case 'growth': return kind === 'growth'
      default: return false
    }
  }

  return <section className="knowledge-manager">
    <div className="panel-title">
      <h3>知识管理</h3>
      <p className="panel-copy">管理 AI 积累的用户画像、经验教训和角色成长记录。冷归档不注入上下文，通过搜索按需检索。</p>
    </div>

    {/* Sub tabs */}
    <div className="knowledge-subtabs">
      <button className={`subtabs-btn ${subTab === 'memory' ? 'active' : ''}`} onClick={() => { setSubTab('memory'); setContent(''); setCurrentFile(''); setEditing(false); setSearchResults([]) }}>
        <User size={14} />用户画像
      </button>
      <button className={`subtabs-btn ${subTab === 'lessons' ? 'active' : ''}`} onClick={() => { setSubTab('lessons'); setContent(''); setCurrentFile(''); setEditing(false); setSearchResults([]) }}>
        <Brain size={14} />经验教训
      </button>
      <button className={`subtabs-btn ${subTab === 'archive' ? 'active' : ''}`} onClick={() => { setSubTab('archive'); setContent(''); setCurrentFile(''); setEditing(false); setSearchResults([]) }}>
        <Archive size={14} />冷归档
      </button>
      <button className={`subtabs-btn ${subTab === 'growth' ? 'active' : ''}`} onClick={() => { setSubTab('growth'); setContent(''); setCurrentFile(''); setEditing(false); setSearchResults([]) }}>
        <Clock size={14} />角色成长
      </button>
    </div>

    {/* Search bar (archive only) */}
    {subTab === 'archive' && <div className="knowledge-search">
      <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()}
        placeholder="搜索冷归档…" className="field-input" style={{ width: '100%' }} />
      <button className="primary-button" onClick={handleSearch} disabled={loading}><Search size={14} />搜索</button>
    </div>}

    {/* Search results */}
    {searchResults.length > 0 && <div className="knowledge-results">
      {searchResults.map((r, i) => <div key={i} className="knowledge-result-item">
        <span className="result-file">{r.file}</span>
        <pre>{r.snippet}</pre>
      </div>)}
    </div>}

    {/* File list */}
    <div className="knowledge-files">
      {files.filter(f => filterFiles(f.kind)).map(f => <div key={f.file}
        className={`knowledge-file-item ${currentFile === f.file ? 'selected' : ''}`}
        onClick={() => loadContent(f.file)}>
        <span className="file-icon">{kindIcon(f.kind)}</span>
        <span className="file-name">{f.file.replace('Characters/', '')}</span>
        <span className="file-kind">{kindLabel(f.kind)}</span>
        {f.exists && <span className="file-size">{(f.size / 1024).toFixed(1)}K</span>}
      </div>)}
      {files.filter(f => filterFiles(f.kind)).length === 0 && <p className="muted" style={{ padding: '1rem' }}>暂无数据</p>}
    </div>

    {/* Content viewer / editor */}
    {currentFile && <div className="knowledge-content">
      <div className="knowledge-content-header">
        <span>{currentFile}</span>
        <div>
          {!editing && <button className="outline-button" onClick={() => { setEditContent(content); setEditing(true) }}><Edit3 size={14} />编辑</button>}
          {editing && <button className="outline-button" onClick={() => setEditing(false)}>取消</button>}
          {editing && <button className="primary-button" onClick={saveContent} disabled={loading}><RefreshCw size={14} />保存</button>}
        </div>
      </div>
      {editing
        ? <textarea className="knowledge-edit" value={editContent} onChange={e => setEditContent(e.target.value)} rows={12} />
        : <pre className="knowledge-preview">{content || '(空)'}</pre>}
      {message && <p className="knowledge-msg">{message}</p>}
    </div>}

    {/* Refresh button */}
    <footer className="drawer-footer">
      <button className="outline-button" onClick={loadFiles}><RefreshCw size={14} />刷新列表</button>
    </footer>
  </section>
}
