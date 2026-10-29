// 辅立码课导入成绩工作台 —— Client 半边（浏览器模块）。
//
// 在「工作台」左侧面板列表注册「导入成绩」入口（sidebar.panellist / id=fuulea-import），
// 并在 layout 的 main 键控槽（key=fuulea-import）渲染整页工作台：
//   学校切换（本机已绑定学校）→ 任务选择（考试×学科）→ 拖入成绩文件（xlsx/xls/csv/zip）
//   → 解析源文件 → 下载模板并填充 → 预检 → 一键导入 → 核对平台回执。
//
// 账号只在首次使用时填写一次：Host 取数成功后把「学校 + 账号密码」保存在本机，
// 之后打开页面直接进入。凭据只在本机保存，页面不回显密码。
//
// 约束：
//   - 只通过 require('react') 取 React，不依赖任何 Harness Client 包；
//   - 所有请求走同源 Host 接口 /fuulea-import/api/*；
//   - 样式只用 --dsw-alias-* / --dsw-specific-* 主题 token；
//   - 不 append 到 document.body，不读取其它插件 DOM。
window.__ModuleLoader__.load({
  id: 'dsh-fuulea-import',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    const PANEL_ID = 'fuulea-import'
    const API_BASE = '/fuulea-import/api'
    const CSS_ID = 'fuulea-import-styles'
    const SCHOOL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*$/i

    // ---------------------------------------------------------------- 样式

    const FLI_CSS =
      '.fli-page{display:flex;flex-direction:column;width:100%;min-width:0;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;box-sizing:border-box}' +
      '.fli-page *,.fli-page *::before,.fli-page *::after{box-sizing:border-box}' +
      '.fli-page :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.fli-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}' +
      '.fli-content{max-width:1160px;margin:0 auto;padding:0 clamp(20px,3vw,44px) 64px}' +
      '.fli-header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 24px;padding-top:28px;margin-bottom:16px}' +
      '[data-platform="darwin"] .fli-header{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}' +
      '.fli-title{margin:0;font-size:20px;font-weight:600;line-height:28px;letter-spacing:.01em}' +
      '.fli-subtitle{margin:2px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}' +
      '.fli-version{display:inline-flex;align-items:center;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;white-space:nowrap}' +
      '.fli-toolbar{padding:16px 18px;margin-bottom:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1)}' +
      '.fli-toolbar-row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 14px}' +
      '.fli-toolbar-row+.fli-toolbar-row{margin-top:12px}' +
      '.fli-field{display:flex;flex-direction:column;gap:5px;min-width:0}' +
      '.fli-field--school{flex:0 1 240px;min-width:180px}' +
      '.fli-field--days{flex:0 0 130px}' +
      '.fli-field--subject{flex:0 0 140px}' +
      '.fli-field--search{flex:0 0 200px}' +
      '.fli-field--task{flex:1 1 320px;min-width:240px}' +
      '.fli-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.fli-input{height:34px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;transition:border-color .15s}' +
      '.fli-input:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.fli-input:disabled{opacity:.6;cursor:not-allowed}' +
      '.fli-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}' +
      '.fli-select{height:34px;min-width:0;max-width:420px;padding:0 30px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary) 50%,transparent 50%);background-position:calc(100% - 16px) 15px,calc(100% - 11px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat;cursor:pointer;transition:border-color .15s}' +
      '.fli-select:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.fli-select:disabled{opacity:.6;cursor:not-allowed}' +
      '.fli-domain{display:inline-flex;align-items:center;height:34px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);overflow:hidden}' +
      '.fli-domain:focus-within{border-color:var(--dsw-alias-brand-primary)}' +
      '.fli-domain-text{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:32px;padding-left:10px;white-space:nowrap}' +
      '.fli-domain-input{width:110px;min-width:0;height:32px;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}' +
      '.fli-domain-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}' +
      '.fli-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto}' +
      // 第一行按钮要和「学校」输入框底部对齐：补一个标签高度（12px 字号 18px 行高 + 5px 间距）
      '.fli-toolbar-row>.fli-actions{padding-top:23px}' +
      '.fli-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 16px;border:1px solid transparent;border-radius:9px;font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;transition:opacity .15s,background-color .15s,border-color .15s;color:var(--dsw-alias-label-primary)}' +
      '.fli-btn:disabled{opacity:.55;cursor:not-allowed}' +
      '.fli-btn--primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}' +
      '.fli-btn--primary:not(:disabled):hover{opacity:.9}' +
      '.fli-btn--ghost{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}' +
      '.fli-btn--ghost:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.fli-btn--danger{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-state-error-primary)}' +
      '.fli-btn--danger:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.fli-btn--small{height:28px;padding:0 12px;font-size:12px}' +
      '.fli-linkbtn{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}' +
      '.fli-linkbtn:hover{text-decoration:underline}' +
      '.fli-linkbtn:disabled{opacity:.55;cursor:not-allowed;text-decoration:none}' +
      '.fli-dropzone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:150px;padding:26px 20px;border:1.5px dashed var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);text-align:center;cursor:pointer;transition:border-color .15s,background-color .15s}' +
      '.fli-dropzone:hover,.fli-dropzone.is-drag{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}' +
      '.fli-dropzone-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.fli-dropzone-note{margin:0;font-size:12px;line-height:18px}' +
      '.fli-files{display:flex;flex-direction:column;gap:8px}' +
      '.fli-file{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px}' +
      '.fli-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}' +
      '.fli-file-meta{display:inline-flex;flex-wrap:wrap;gap:4px 10px;color:var(--dsw-alias-label-secondary)}' +
      '.fli-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}' +
      '.fli-chip--ok{color:var(--dsw-alias-label-primary)}' +
      '.fli-chip--ok::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22a06b);flex:none}' +
      '.fli-chip--err::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d);flex:none}' +
      '.fli-chip--err{color:var(--dsw-alias-state-error-primary)}' +
      '.fli-section{margin-bottom:20px}' +
      '.fli-section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin-bottom:10px}' +
      '.fli-section-title{margin:0;font-size:15px;font-weight:600;line-height:22px}' +
      '.fli-section-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.fli-alert{display:flex;align-items:flex-start;gap:9px;padding:10px 14px;margin:0 0 16px;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}' +
      '.fli-alert--error{border-color:var(--dsw-alias-state-error-primary)}' +
      '.fli-alert--warn{border-color:var(--dsw-alias-state-warn-primary)}' +
      '.fli-alert--ok{border-color:var(--dsw-alias-state-success-primary)}' +
      '.fli-alert-icon{flex:none;margin-top:1px;font-size:13px;font-weight:700;line-height:18px}' +
      '.fli-alert--error .fli-alert-icon{color:var(--dsw-alias-state-error-primary)}' +
      '.fli-alert--warn .fli-alert-icon{color:var(--dsw-alias-state-warn-primary)}' +
      '.fli-alert--ok .fli-alert-icon{color:var(--dsw-alias-state-success-primary)}' +
      '.fli-alert-body{flex:1;min-width:0}' +
      '.fli-alert-title{margin:0;font-weight:500;color:var(--dsw-alias-label-primary)}' +
      '.fli-alert-message{margin:0;overflow-wrap:anywhere}' +
      '.fli-steps{display:flex;flex-direction:column;gap:8px}' +
      '.fli-step{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1)}' +
      '.fli-step-dot{flex:none;width:18px;height:18px;margin-top:2px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}' +
      '.fli-step-dot--todo{background:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}' +
      '.fli-step-dot--busy{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}' +
      '.fli-step-dot--done{background:var(--dsw-alias-state-success-primary,#22a06b);color:#fff}' +
      '.fli-step-dot--err{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}' +
      '.fli-step-main{flex:1;min-width:0}' +
      '.fli-step-title{font-size:13px;font-weight:600;line-height:20px}' +
      '.fli-step-meta{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}' +
      '.fli-step-actions{display:flex;flex-wrap:wrap;gap:8px;align-self:center}' +
      '.fli-log{max-height:260px;overflow:auto;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:18px}' +
      '.fli-log-row{display:flex;gap:8px;color:var(--dsw-alias-label-secondary)}' +
      '.fli-log-time{flex:none;color:var(--dsw-alias-label-secondary);opacity:.7}' +
      '.fli-log-msg{overflow-wrap:anywhere}' +
      '.fli-log-row.is-ok .fli-log-msg{color:var(--dsw-alias-label-primary)}' +
      '.fli-log-row.is-err .fli-log-msg{color:var(--dsw-alias-state-error-primary)}' +
      '.fli-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}' +
      '.fli-table th{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:500;text-align:left;white-space:nowrap}' +
      '.fli-table td{padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}' +
      '.fli-table tbody tr:last-child td{border-bottom:0}' +
      '.fli-table tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}' +
      '.fli-table-wrap{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}' +
      '.fli-table-scroll{overflow-x:auto;scrollbar-gutter:stable}' +
      '.fli-muted{color:var(--dsw-alias-label-secondary)}' +
      '.fli-confirm{display:flex;align-items:center;gap:8px;margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}' +
      '.fli-check{display:inline-flex;align-items:center;gap:7px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}' +
      '.fli-check input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}' +
      '.fli-notes{margin:10px 0 0;padding-left:20px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}' +
      '.fli-notes li{overflow-wrap:anywhere}' +
      '.fli-spinner{flex:none;width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:fli-spin .8s linear infinite}' +
      '@keyframes fli-spin{to{transform:rotate(360deg)}}'

    function StyleSheet() {
      // 以 React 元素挂在页面里：槽位卸载时样式会一起卸载，不需要也不应该
      // 向 document.head / document.body 写入样式节点。
      return h('style', { 'data-fli-style': CSS_ID }, FLI_CSS)
    }

    // ---------------------------------------------------------------- 工具

    function messageOf(err) {
      if (!err) return '未知错误'
      if (typeof err === 'string') return err
      if (err && err.message) return err.message
      if (err && err.error) return err.error
      return String(err)
    }

    async function api(method, path, body) {
      const res = await fetch(API_BASE + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      let json = null
      try { json = await res.json() } catch { /* 非 JSON */ }
      if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status))
      return json
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => {
          const text = String(r.result || '')
          const comma = text.indexOf(',')
          resolve(comma >= 0 ? text.slice(comma + 1) : text)
        }
        r.onerror = () => reject(new Error('读取文件失败：' + file.name))
        r.readAsDataURL(file)
      })
    }

    function nowTime() {
      const d = new Date()
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
    }

    // ---------------------------------------------------------------- 组件

    /** 题号展示：优先用源表/模板的原始表头（如一、四(1)），标准化题号不同时附在括号里。 */
    function rawLabel(analysis, side, qno) {
      const raw = side === 'source' ? analysis.rawSourceHeaders : analysis.rawTargetHeaders
      const norm = side === 'source' ? analysis.sourceHeaders : analysis.targetHeaders
      const idx = (norm || []).indexOf(String(qno))
      const orig = idx >= 0 && raw && raw[idx] !== undefined ? String(raw[idx]) : ''
      if (!orig) return String(qno)
      return orig === String(qno) ? orig : orig + '（' + qno + '）'
    }

    function Spinner() {
      return h('span', { className: 'fli-spinner', 'aria-hidden': true })
    }

    function Alert(props) {
      const kind = props.kind || 'warn'
      const icon = kind === 'error' ? '✕' : kind === 'ok' ? '✓' : '!'
      return h('div', { className: 'fli-alert fli-alert--' + kind, role: 'status' },
        h('span', { className: 'fli-alert-icon' }, icon),
        h('div', { className: 'fli-alert-body' },
          props.title ? h('p', { className: 'fli-alert-title' }, props.title) : null,
          h('p', { className: 'fli-alert-message' }, props.message),
        ),
      )
    }

    function PanelIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 64 64', 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: 'currentColor', opacity: 0.16 }),
        h('path', {
          d: 'M17 22 h22 a4 4 0 0 1 4 4 v18 a4 4 0 0 1 -4 4 H20 a4 4 0 0 1 -4 -4 Z M26 32 l4 4 l9 -9',
          fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    // ---------------------------------------------------------------- 主页面

    function ImportPage() {
      const [defaults, setDefaults] = useState(null)
      const [version, setVersion] = useState('')
      const [school, setSchool] = useState('')
      const [groups, setGroups] = useState([])
      const [selectedTask, setSelectedTask] = useState('')
      const [taskGroupsBusy, setTaskGroupsBusy] = useState(false)
      const [taskQuery, setTaskQuery] = useState('')
      const [daysWindow, setDaysWindow] = useState(90)
      const [hiddenByTime, setHiddenByTime] = useState(0)
      const [subjectFilter, setSubjectFilter] = useState('')
      const [subjects, setSubjects] = useState([])
      const [showBind, setShowBind] = useState(false)
      const [bindSchool, setBindSchool] = useState('lyyz')
      const [bindUser, setBindUser] = useState('')
      const [bindPass, setBindPass] = useState('')

      const [files, setFiles] = useState([]) // [{name, bytes, subjectGuess, count, questionCount, error}]
      const [filled, setFilled] = useState(null) // {name, bytes, data, students, skipped, blankCells, extraInScores}
      const [precheck, setPrecheck] = useState(null)
      const [analysis, setAnalysis] = useState(null) // /analyze 结果：题号映射方案
      const [batch, setBatch] = useState(null) // /batch-scan 结果：批量体检清单
      const [planConfirmed, setPlanConfirmed] = useState(false)

      const [busy, setBusy] = useState('') // 'tasks' | 'parse' | 'fill' | 'precheck' | 'import' | 'receipt' | ''
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [log, setLog] = useState([])
      const [receipts, setReceipts] = useState(null)
      // 本次导入的提交时刻（UTC）。回执只认这之后产生的，避免把历史回执算成"失败"。
      const importSinceRef = useRef('')

      const dragDepth = useRef(0)
      const [dragging, setDragging] = useState(false)
      const fileInputRef = useRef(null)
      const mountedRef = useRef(true)

      const pushLog = (msg, kind) => {
        setLog((prev) => [...prev.slice(-200), { t: nowTime(), msg, kind }])
      }

      const clearError = () => setError('')

      useEffect(() => {
        mountedRef.current = true
        api('GET', '/defaults')
          .then((d) => {
            if (!mountedRef.current) return
            setDefaults(d.defaults)
            setVersion(d.version)
            const s = d.defaults.school
            setSchool(s)
          })
          .catch((err) => { if (mountedRef.current) setError('加载配置失败：' + messageOf(err)) })
        return () => { mountedRef.current = false }
      }, [])

      const selectedGroup = groups.find((g) => String(g.taskId) === String(selectedTask)) || null

      // 任务搜索：先按学科筛选，再按关键词模糊过滤（任务名 / 学科 / 班级）。
      const taskQueryTrim = taskQuery.trim().toLowerCase()
      const subjectFiltered = subjectFilter ? groups.filter((g) => g.subject === subjectFilter) : groups
      const filteredGroups = taskQueryTrim
        ? subjectFiltered.filter((g) => {
            const hay = (g.exam + ' ' + g.subject + ' ' + g.className + ' ' + g.title).toLowerCase()
            // 空格分隔的多关键词需全部命中
            return taskQueryTrim.split(/\s+/).every((kw) => hay.includes(kw))
          })
        : subjectFiltered

      async function doBind() {
        const alias = bindSchool.trim()
        if (!SCHOOL_ALIAS_PATTERN.test(alias)) { setError('学校子域名只能包含字母、数字和连字符'); return }
        if (!bindUser.trim() || !bindPass) { setError('请填写账号和密码'); return }
        setBusy('bind')
        setError('')
        try {
          const r = await api('POST', '/bind', { school: alias, username: bindUser, password: bindPass })
          setDefaults((prev) => ({ ...prev, bindings: r.bindings }))
          setBindPass('')
          setShowBind(false)
          await onSchoolChange(alias)
          setNotice('学校绑定成功，下次打开工作台无需再输入账号密码。')
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy('')
        }
      }

      async function loadTasks() {
        if (!school) { setError('请先选择或绑定学校'); return }
        setTaskGroupsBusy(true)
        setError('')
        setNotice('')
        try {
          const r = await api('POST', '/tasks', { school, days: daysWindow })
          setGroups(r.groups || [])
          setSubjects(r.subjects || [])
          setHiddenByTime(r.hiddenByTime || 0)
          setSubjectFilter('')
          setTaskQuery('')
          setSelectedTask('')
          pushLog('已加载 ' + (r.groupTotal || 0) + ' 个任务（' + (r.taskTotal || 0) + ' 条）', 'ok')
        } catch (err) {
          const msg = messageOf(err)
          setError('加载任务失败：' + msg)
          pushLog('加载任务失败：' + msg, 'err')
        } finally {
          setTaskGroupsBusy(false)
        }
      }

      // 学校切换：切换后自动拉任务（已绑定学校）
      async function onSchoolChange(next) {
        setSchool(next)
        setGroups([])
        setSubjects([])
        setSubjectFilter('')
        setTaskQuery('')
        setSelectedTask('')
        setFilled(null)
        setPrecheck(null)
        setReceipts(null)
        if (next) await loadTasksFor(next)
      }

      async function loadTasksFor(s) {
        setTaskGroupsBusy(true)
        setError('')
        try {
          const r = await api('POST', '/tasks', { school: s, days: daysWindow })
          setGroups(r.groups || [])
          setSubjects(r.subjects || [])
          setHiddenByTime(r.hiddenByTime || 0)
          setSubjectFilter('')
          setTaskQuery('')
          setSelectedTask('')
        } catch (err) {
          setError('加载任务失败：' + messageOf(err))
        } finally {
          setTaskGroupsBusy(false)
        }
      }

      // 选文件：立刻把内容读成 base64 存进 state。
      // ⚠️ 不能只存 File 引用——input 的 value 被清空 / 组件重渲染后，
      // 某些浏览器下 File 对象会失效，点「解析」时读不到内容，表现为「点了没反应」。
      async function onFilesPicked(list) {
        const arr = Array.from(list || [])
        if (!arr.length) return
        clearError()
        setBusy('parse')
        pushLog('正在读取 ' + arr.length + ' 个文件…', '')
        try {
          const next = []
          for (const f of arr) {
            try {
              const data = await readFileAsBase64(f)
              next.push({ name: f.name, bytes: f.size, data, error: '' })
            } catch (e) {
              next.push({ name: f.name, bytes: f.size, data: '', error: '读取失败：' + messageOf(e) })
            }
          }
          setFiles(next)
          setFilled(null)
          setPrecheck(null)
          setReceipts(null)
          setAnalysis(null)
          setPlanConfirmed(false)
          setBatch(null)
          const okCount = next.filter((f) => f.data).length
          pushLog('已读取 ' + okCount + '/' + next.length + ' 个文件，点「解析文件」继续', okCount ? 'ok' : 'err')
          if (!okCount) setError('文件读取失败，请重新选择')
        } finally {
          setBusy('')
        }
      }

      async function doParse() {
        if (!files.length) { setError('请先拖入成绩文件'); return }
        setBusy('parse')
        setError('')
        try {
          const list = files.map((f) => ({ name: f.name, bytes: f.bytes, data: f.data }))
          const r = await api('POST', '/parse', { school, files: list })
          const parsed = r.files || []
          setFiles((prev) => prev.map((f) => {
            const p = parsed.find((x) => x.name === f.name)
            if (!p) return f
            return { ...f, subjectGuess: p.subjectGuess || '', count: p.count, questionCount: p.questionCount, error: p.error }
          }))
          const errCount = parsed.filter((p) => p.error).length
          pushLog('解析完成：' + parsed.length + ' 份，' + errCount + ' 份有问题', errCount ? 'err' : 'ok')
          if (errCount) setError('有 ' + errCount + ' 份文件解析有问题，见文件列表标记')
          else {
            const first = parsed.find((p) => !p.error)
            if (first) setNotice('解析成功：' + first.name + '，' + (first.count || 0) + ' 人 × ' + (first.questionCount || 0) + ' 题')
          }
        } catch (err) {
          setError('解析失败：' + messageOf(err))
          pushLog('解析失败：' + messageOf(err), 'err')
        } finally {
          setBusy('')
        }
      }

      function firstGoodFile() {
        // 批量体检里手动选过某份 → 用它；否则用第一份可读的
        const picked = files.find((f) => f.selected && !f.error && f.data)
        return picked || files.find((f) => !f.error && f.data)
      }

      // 批量体检：一堆文件里挑出能用的（只读）
      async function doBatchScan() {
        if (!files.length) { setError('请先拖入文件'); return }
        if (!selectedTask) { setError('请先选择任务（批量体检要用模板名单判定可用性）'); return }
        setBusy('batch')
        setError('')
        setNotice('')
        try {
          const list = files.filter((f) => f.data).map((f) => ({ name: f.name, data: f.data }))
          const r = await api('POST', '/batch-scan', { school, taskId: selectedTask, files: list })
          setBatch(r)
          pushLog('批量体检：' + r.total + ' 份中 ' + r.usableCount + ' 份可用、' + r.skippedCount + ' 份跳过', r.usableCount ? 'ok' : 'err')
          if (!r.usableCount) setError('没有可用的文件（见下方原因）')
        } catch (err) {
          setError('批量体检失败：' + messageOf(err))
          pushLog('批量体检失败：' + messageOf(err), 'err')
        } finally {
          setBusy('')
        }
      }

      // 把批量体检里可用的第 n 份设为当前源文件（后续分析/填充走它）
      function useBatchFile(name) {
        const item = files.find((f) => f.name === name)
        if (!item) return
        setFiles((prev) => prev.map((f) => ({ ...f, selected: f.name === name })))
        setAnalysis(null)
        setPlanConfirmed(false)
        setFilled(null)
        setPrecheck(null)
        pushLog('已选用文件：' + name, '')
      }

      async function doAnalyze() {
        const src = firstGoodFile()
        if (!src) { setError('没有可用的源文件（请先拖入并解析）'); return }
        if (!selectedTask) { setError('请先选择要导入的任务'); return }
        setBusy('analyze')
        setError('')
        setNotice('')
        try {
          const r = await api('POST', '/analyze', {
            school,
            taskId: selectedTask,
            taskTitle: selectedGroup ? selectedGroup.exam : '',
            subject: selectedGroup ? selectedGroup.subject : '',
            sourceFile: { name: src.name, data: src.data },
          })
          setAnalysis(r)
          setPlanConfirmed(false)
          setFilled(null)
          setPrecheck(null)
          if (r.fillable && !r.needsConfirm) {
            pushLog('题号映射：完全一致，可直接填充', 'ok')
          } else if (r.fillable) {
            pushLog('题号映射已给出，需要你确认后填充', '')
          } else {
            const n = (r.unfillable || []).length
            pushLog('题号映射存在问题：' + n + ' 个题号无法精确对应', 'err')
          }
          if (r.aiUsed) pushLog('已使用 AI 辅助判断题号对应关系（仅建议，需人工确认）', '')
          if (r.aiError) pushLog(r.aiError, '')
        } catch (err) {
          setError('分析失败：' + messageOf(err))
          pushLog('分析失败：' + messageOf(err), 'err')
        } finally {
          setBusy('')
        }
      }

      async function doFill() {
        const src = firstGoodFile()
        if (!src) { setError('没有可用的源文件（请先拖入并解析）'); return }
        if (!selectedTask) { setError('请先选择要导入的任务'); return }
        // 若分析出不可自动填的情况，必须先人工确认
        if (analysis && analysis.needsConfirm && !planConfirmed) {
          setError('题号对应关系需要你确认后才能填充（见「题号映射」卡片）')
          return
        }
        setBusy('fill')
        setError('')
        try {
          const data = src.data
          // 没做过题号映射分析时，先自动分析一次再填——
          // 否则源表与模板列数不同（多一列合计、题组结构等）会直接报「题数不一致」。
          let plan = analysis && analysis.plan && analysis.plan.length ? analysis.plan : null
          if (!plan) {
            const auto = await api('POST', '/analyze', {
              school,
              taskId: selectedTask,
              taskTitle: selectedGroup ? selectedGroup.exam : '',
              subject: selectedGroup ? selectedGroup.subject : '',
              sourceFile: { name: src.name, data },
            })
            setAnalysis(auto)
            if (auto.needsConfirm) {
              setError('题号对应关系需要你确认后才能填充（见「题号映射」卡片）')
              pushLog('需要先确认题号映射，已暂停填充', 'err')
              return
            }
            plan = auto.plan && auto.plan.length ? auto.plan : null
          }
          const r = await api('POST', '/fill', {
            school,
            taskId: selectedTask,
            sourceFile: { name: src.name, data },
            plan: plan || undefined,
          })
          setFilled(r.filled ? { ...r.filled, students: r.students, skipped: r.skipped, blankCells: r.blankCells, extraInScores: r.extraInScores, questionCount: r.questionCount, rosterCount: r.rosterCount } : null)
          pushLog('填充完成：' + r.students + ' 人 × ' + r.questionCount + ' 题（跳过缺考 ' + r.skipped + ' 人）', 'ok')
          if (r.extraInScores && r.extraInScores.length) {
            setError('有 ' + r.extraInScores.length + ' 名学生不在班级对照表里（会报「学生班级未找到」）：' + r.extraInScores.slice(0, 8).join('、'))
          }
        } catch (err) {
          setError('填充失败：' + messageOf(err))
          pushLog('填充失败：' + messageOf(err), 'err')
        } finally {
          setBusy('')
        }
      }

      async function doPrecheck() {
        if (!filled) { setError('请先填充模板'); return }
        setBusy('precheck')
        setError('')
        try {
          const r = await api('POST', '/precheck', { school, taskId: selectedTask, filledFile: { name: filled.name, data: filled.data } })
          setPrecheck(r)
          if (r.ok) {
            const capNote = r.maxScoreAvailable ? '，分值上限校验通过' : ''
            pushLog('预检通过：' + r.students + ' 人，空格 ' + r.empty_cells + ' 个' + capNote, 'ok')
            if (r.maxScoreWarning) pushLog(r.maxScoreWarning, '')
          } else {
            const reasons = []
            if (r.blank_rows && r.blank_rows.length) reasons.push('整行空 ' + r.blank_rows.length + ' 人')
            if (r.partial_rows && r.partial_rows.length) reasons.push('部分空 ' + r.partial_rows.length + ' 人')
            if (r.extra_in_scores && r.extra_in_scores.length) reasons.push('对照表外 ' + r.extra_in_scores.length + ' 人')
            if (r.over_limit_cells) reasons.push('分值超上限 ' + r.over_limit_cells + ' 格')
            if (r.no_subscores) reasons.push('无小题分')
            setError('预检未通过：' + (reasons.join('、') || '见详情'))
            pushLog('预检未通过：' + reasons.join('、'), 'err')
          }
        } catch (err) {
          setError('预检失败：' + messageOf(err))
          pushLog('预检失败：' + messageOf(err), 'err')
        } finally {
          setBusy('')
        }
      }

      async function doImport() {
        if (!filled) { setError('请先填充模板'); return }
        if (!selectedTask) { setError('请先选择要导入的任务'); return }
        // 生产站写操作提示
        setBusy('import')
        setError('')
        try {
          // 记录提交前一刻（UTC，留 30 秒余量），回执只统计这之后的
          importSinceRef.current = new Date(Date.now() - 30_000).toISOString()
          const r = await api('POST', '/import', { school, taskId: selectedTask, filledFile: { name: filled.name, data: filled.data } })
          pushLog('已提交导入：taskId=' + selectedTask + '（后台导入，结果看回执）', 'ok')
          setNotice('已提交导入，正在核对平台回执…')
          await doReceipt([filled.name])
        } catch (err) {
          setError('导入失败：' + messageOf(err))
          pushLog('导入失败：' + messageOf(err), 'err')
        } finally {
          setBusy('')
        }
      }

      async function doReceipt(fileNames) {
        setBusy((b) => b || 'receipt')
        try {
          const r = await api('POST', '/receipt', {
            school,
            fileNames: fileNames || (filled ? [filled.name] : []),
            // 只统计本次导入之后的回执，历史回执不算进"失败"
            sinceISO: importSinceRef.current || '',
          })
          setReceipts(r)
          if (r.failCount) {
            pushLog('回执：成功 ' + r.successCount + ' 条、失败 ' + r.failCount + ' 条', 'err')
          } else {
            pushLog('回执：成功 ' + r.successCount + ' 条', 'ok')
          }
        } catch (err) {
          setError('核对回执失败：' + messageOf(err))
          pushLog('核对回执失败：' + messageOf(err), 'err')
        } finally {
          setBusy((b) => (b === 'receipt' ? '' : b))
        }
      }

      // 拖放
      function onDragEnter(e) {
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }
      function onDragLeave(e) {
        e.preventDefault()
        dragDepth.current -= 1
        if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) }
      }
      function onDragOver(e) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      }
      function onDrop(e) {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        if (e.dataTransfer && e.dataTransfer.files) onFilesPicked(e.dataTransfer.files)
      }

      const bindings = defaults ? defaults.bindings : []
      const busyAny = Boolean(busy)

      return h('div', { className: 'fli-page', 'aria-busy': busyAny ? 'true' : 'false' },
        h(StyleSheet),
        h('div', { className: 'fli-scroll' },
          h('div', { className: 'fli-content' },

            // 顶栏
            h('div', { className: 'fli-header' },
              h('div', {},
                h('h1', { className: 'fli-title' }, '导入成绩'),
                h('p', { className: 'fli-subtitle' }, '把成绩文件（表格或压缩包）拖进来，一键填充模板、预检并导入辅立码课'),
              ),
              h('div', {},
                version ? h('span', { className: 'fli-version' }, 'v' + version) : null,
              ),
            ),

            // 工具栏：学校 + 任务
            h('div', { className: 'fli-toolbar' },
              // 第一行：学校 + 操作按钮
              h('div', { className: 'fli-toolbar-row' },
                h('div', { className: 'fli-field fli-field--school' },
                  h('label', { className: 'fli-field-label' }, '学校'),
                  h('select', {
                    className: 'fli-select', value: school, disabled: busyAny,
                    onChange: (e) => onSchoolChange(e.target.value),
                  },
                    h('option', { value: '' }, '请选择学校'),
                    bindings.map((b) => h('option', { key: b.alias, value: b.alias }, b.siteTitle || b.alias + '.fuulea.com')),
                  ),
                ),
                h('div', { className: 'fli-actions' },
                  h('button', {
                    className: 'fli-btn fli-btn--ghost fli-btn--small', disabled: busyAny || !school,
                    onClick: loadTasks,
                  }, taskGroupsBusy ? h(Spinner) : '加载任务'),
                  h('button', {
                    className: 'fli-btn fli-btn--ghost fli-btn--small', disabled: busyAny,
                    onClick: () => setShowBind((v) => !v),
                  }, showBind ? '收起绑定' : '＋ 绑定学校'),
                ),
              ),
              // 第二行：时间范围 + 科目筛选 + 搜索 + 任务选择
              h('div', { className: 'fli-toolbar-row' },
                h('div', { className: 'fli-field fli-field--days' },
                  h('label', { className: 'fli-field-label' }, '时间范围'),
                  h('select', {
                    className: 'fli-select', value: String(daysWindow), disabled: busyAny,
                    onChange: (e) => { setDaysWindow(Number(e.target.value)); loadTasksFor(school) },
                  },
                    h('option', { value: '7' }, '最近 7 天'),
                    h('option', { value: '30' }, '最近 30 天'),
                    h('option', { value: '90' }, '最近 90 天'),
                    h('option', { value: '365' }, '最近一年'),
                    h('option', { value: '0' }, '全部'),
                  ),
                ),
                h('div', { className: 'fli-field fli-field--subject' },
                  h('label', { className: 'fli-field-label' }, '科目'),
                  h('select', {
                    className: 'fli-select', value: subjectFilter,
                    disabled: busyAny || !groups.length,
                    onChange: (e) => { setSubjectFilter(e.target.value); setSelectedTask(''); setFilled(null); setPrecheck(null); setReceipts(null); setAnalysis(null); setPlanConfirmed(false); setBatch(null) },
                  },
                    h('option', { value: '' }, groups.length ? '全部科目' : '—'),
                    subjects.map((s) => h('option', { key: s.name, value: s.name }, s.name + '（' + s.count + '）')),
                  ),
                ),
                h('div', { className: 'fli-field fli-field--search' },
                  h('label', { className: 'fli-field-label' }, '搜索'),
                  h('input', {
                    className: 'fli-input', value: taskQuery,
                    disabled: busyAny || !groups.length,
                    placeholder: groups.length ? ('任务名 / 班级（共 ' + filteredGroups.length + ' 个）') : '先点「加载任务」',
                    onChange: (e) => setTaskQuery(e.target.value),
                  }),
                ),
                h('div', { className: 'fli-field fli-field--task' },
                  h('label', { className: 'fli-field-label' }, '任务'),
                  h('select', {
                    className: 'fli-select', value: selectedTask,
                    disabled: busyAny || !filteredGroups.length,
                    onChange: (e) => { setSelectedTask(e.target.value); setFilled(null); setPrecheck(null); setReceipts(null); setAnalysis(null); setPlanConfirmed(false); setBatch(null) },
                  },
                    h('option', { value: '' }, filteredGroups.length ? '请选择任务' : (groups.length ? '没有匹配的任务' : '先点「加载任务」')),
                    filteredGroups.slice(0, 300).map((g) => h('option', { key: g.taskId, value: String(g.taskId) }, g.exam + ' · ' + g.subject + '（' + g.className + '）')),
                  ),
                  filteredGroups.length > 300
                    ? h('p', { className: 'fli-field-label' }, '匹配 ' + filteredGroups.length + ' 个，只显示前 300，请缩小关键词')
                    : hiddenByTime > 0
                      ? h('p', { className: 'fli-field-label' }, '已隐藏 ' + hiddenByTime + ' 个较早任务，可调大「时间范围」')
                      : null,
                ),
              ),
              showBind ? h('div', { className: 'fli-toolbar-row' },
                h('div', { className: 'fli-field' },
                  h('label', { className: 'fli-field-label' }, '学校子域名'),
                  h('div', { className: 'fli-domain' },
                    h('input', { className: 'fli-domain-input', value: bindSchool, onChange: (e) => setBindSchool(e.target.value), placeholder: 'lyyz' }),
                    h('span', { className: 'fli-domain-text' }, '.fuulea.com'),
                  ),
                ),
                h('div', { className: 'fli-field' },
                  h('label', { className: 'fli-field-label' }, '账号'),
                  h('input', { className: 'fli-input', value: bindUser, autoComplete: 'username', onChange: (e) => setBindUser(e.target.value) }),
                ),
                h('div', { className: 'fli-field' },
                  h('label', { className: 'fli-field-label' }, '密码'),
                  h('input', { className: 'fli-input', type: 'password', value: bindPass, autoComplete: 'current-password', onChange: (e) => setBindPass(e.target.value) }),
                ),
                h('div', { className: 'fli-actions' },
                  h('button', { className: 'fli-btn fli-btn--primary fli-btn--small', disabled: busyAny, onClick: doBind }, busy === 'bind' ? h(Spinner) : '验证并绑定'),
                ),
              ) : null,
            ),

            error ? h(Alert, { kind: 'error', message: error }) : null,
            notice && !error ? h(Alert, { kind: 'ok', message: notice }) : null,

            // 文件拖放
            h('div', { className: 'fli-section' },
              h('div', { className: 'fli-section-head' },
                h('h2', { className: 'fli-section-title' }, '① 成绩文件'),
                h('div', { className: 'fli-actions' },
                  h('button', { className: 'fli-btn fli-btn--ghost fli-btn--small', onClick: () => fileInputRef.current && fileInputRef.current.click() }, '选择文件'),
                  h('button', { className: 'fli-btn fli-btn--primary fli-btn--small', disabled: busyAny || !files.length, onClick: doParse }, busy === 'parse' ? h(Spinner) : '解析文件'),
                  h('button', { className: 'fli-btn fli-btn--ghost fli-btn--small', disabled: busyAny || !files.length || !selectedTask, onClick: doBatchScan }, busy === 'batch' ? h(Spinner) : '批量体检'),
                  h('button', { className: 'fli-btn fli-btn--ghost fli-btn--small', disabled: busyAny || !firstGoodFile() || !selectedTask, onClick: doAnalyze }, busy === 'analyze' ? h(Spinner) : '分析题号映射'),
                ),
              ),
              h('input', {
                type: 'file', multiple: true, accept: '.xlsx,.xls,.csv,.zip',
                style: { display: 'none' }, ref: fileInputRef,
                onChange: (e) => { onFilesPicked(e.target.files); e.target.value = '' },
              }),
              h('div', {
                className: 'fli-dropzone' + (dragging ? ' is-drag' : ''),
                onClick: () => fileInputRef.current && fileInputRef.current.click(),
                onDragEnter: onDragEnter, onDragLeave: onDragLeave, onDragOver: onDragOver, onDrop: onDrop,
              },
                h('span', { className: 'fli-dropzone-title' }, '拖入成绩文件到这里，或点击选择'),
                h('p', { className: 'fli-dropzone-note' }, '支持 .xlsx / .xls / .csv，或打包成 .zip 的多个文件；自动识别姓名列、题号列与总分列'),
              ),
              files.length ? h('div', { className: 'fli-files', style: { marginTop: 10 } },
                files.map((f, i) => h('div', { key: i, className: 'fli-file' },
                  h('span', { className: 'fli-file-name' }, f.name),
                  h('span', { className: 'fli-file-meta' },
                    h('span', null, (f.bytes / 1024).toFixed(1) + ' KB'),
                    f.data ? h('span', { className: 'fli-chip fli-chip--ok' }, '已读取') : h('span', { className: 'fli-chip fli-chip--err' }, '未读取'),
                    f.subjectGuess ? h('span', { className: 'fli-chip fli-chip--ok' }, f.subjectGuess) : null,
                    f.count != null ? h('span', null, f.count + ' 人') : null,
                    f.questionCount != null ? h('span', null, f.questionCount + ' 题') : null,
                    f.error ? h('span', { className: 'fli-chip fli-chip--err' }, f.error) : null,
                  ),
                )),
              ) : null,
            ),

            // 批量体检结果：一堆文件里哪些能用
            batch ? h('div', { className: 'fli-section' },
              h('div', { className: 'fli-section-head' },
                h('h2', { className: 'fli-section-title' }, '批量体检'),
                h('p', { className: 'fli-section-note' },
                  '共 ' + batch.total + ' 份：可用 ' + batch.usableCount + '、跳过 ' + batch.skippedCount
                  + '　·　模板名单 ' + batch.rosterCount + ' 人 / ' + batch.templateQuestionCount + ' 题'),
              ),
              batch.usableCount === 0
                ? h(Alert, { kind: 'error', title: '没有可用的文件', message: '请对照下方「跳过原因」检查文件内容' })
                : null,
              h('div', { className: 'fli-table-wrap' },
                h('div', { className: 'fli-table-scroll' },
                  h('table', { className: 'fli-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, '文件'), h('th', null, '状态'), h('th', null, '学生'), h('th', null, '题数'),
                      h('th', null, '匹配名单'), h('th', null, '说明'))),
                    h('tbody', null, (batch.files || []).map((f, i) => h('tr', { key: i },
                      h('td', null, f.name),
                      h('td', null, f.usable
                        ? h('span', { className: 'fli-chip fli-chip--ok' }, '可用')
                        : h('span', { className: 'fli-chip fli-chip--err' }, '跳过')),
                      h('td', null, f.students || '—'),
                      h('td', null, f.questionCount || '—'),
                      h('td', null, f.total ? (f.matched + '/' + f.total) : '—'),
                      h('td', null, f.usable
                        ? h('button', {
                            className: 'fli-linkbtn',
                            onClick: () => useBatchFile(f.name),
                          }, '用这份')
                        : (f.reason || '')),
                    ))),
                  ),
                ),
              ),
            ) : null,

            // 题号映射方案（AI/规则给出，必须人工确认才能填）
            analysis ? h('div', { className: 'fli-section' },
              h('div', { className: 'fli-section-head' },
                h('h2', { className: 'fli-section-title' }, '题号映射'),
                h('p', { className: 'fli-section-note' },
                  '源表 ' + (analysis.sourceHeaders || []).length + ' 列 → 模板 ' + (analysis.targetHeaders || []).length + ' 列'
                  + (analysis.aiUsed ? '　·　已用 AI 辅助（仅建议）' : '　·　规则判定')),
              ),

              analysis.aiError ? h(Alert, { kind: 'warn', message: analysis.aiError }) : null,

              // 无法精确对应 → 明确阻断
              analysis.unfillable && analysis.unfillable.length
                ? h(Alert, {
                    kind: 'error',
                    title: '有 ' + analysis.unfillable.length + ' 个题号无法精确对应，不会自动填',
                    message: analysis.unfillable.map((u) => '题号 ' + u.sourceQno + '：' + u.reason).join('；'),
                  })
                : null,

              analysis.missingInSource && analysis.missingInSource.length
                ? h(Alert, {
                    kind: 'warn',
                    title: '模板有 ' + analysis.missingInSource.length + ' 个题号在源表里没有对应',
                    message: analysis.missingInSource.join('、') + '（这些格会留空，平台会整份拒收）',
                  })
                : null,

              analysis.mappings && analysis.mappings.length
                ? h('div', { className: 'fli-table-wrap' },
                    h('div', { className: 'fli-table-scroll' },
                      h('table', { className: 'fli-table' },
                        h('thead', null, h('tr', null,
                          h('th', null, '源表题号'), h('th', null, '模板题号'), h('th', null, '方式'), h('th', null, '说明'))),
                        h('tbody', null, analysis.mappings.map((m, i) => h('tr', { key: i },
                          h('td', null, rawLabel(analysis, 'source', m.sourceQno)),
                          h('td', null, rawLabel(analysis, 'target', m.targetQno)),
                          h('td', null, m.kind === 'exact' ? '直接对应'
                            : m.kind === 'sub-merge' ? '小题合并'
                            : m.kind === 'ai' ? 'AI 建议'
                            : '按位置'),
                          h('td', null, m.reason || (m.needsConfirm ? '需确认' : '')),
                        ))),
                      ),
                    ),
                  )
                : null,

              // 需要确认时给勾选
              analysis.needsConfirm
                ? h('div', { className: 'fli-confirm' },
                    h('label', { className: 'fli-check' },
                      h('input', {
                        type: 'checkbox', checked: planConfirmed,
                        onChange: (e) => setPlanConfirmed(e.target.checked),
                      }),
                      h('span', null, '我已核对上述题号对应关系，确认无误'),
                    ),
                  )
                : null,

              analysis.notes && analysis.notes.length
                ? h('ul', { className: 'fli-notes' }, analysis.notes.map((n, i) => h('li', { key: i }, n)))
                : null,
            ) : null,

            // 流程步骤
            h('div', { className: 'fli-section' },
              h('div', { className: 'fli-section-head' },
                h('h2', { className: 'fli-section-title' }, '② 填充与导入'),
                h('p', { className: 'fli-section-note' }, '选好任务、解析好文件后，按步骤执行'),
              ),
              h('div', { className: 'fli-steps' },
                step(2, '填充模板', filled ? '已填充 ' + filled.students + ' 人 × ' + filled.questionCount + ' 题' + (filled.skipped ? '，跳过缺考 ' + filled.skipped + ' 人' : '') : '下载班级对照表模板并自动填充', filled ? 'done' : (busy === 'fill' ? 'busy' : 'todo'), filled ? null : doFill, busy === 'fill' ? h(Spinner) : '填充模板', busyAny || !selectedTask || !firstGoodFile()),
                step(3, '预检', precheck ? (precheck.ok ? '通过：' + precheck.students + ' 人，空格 ' + precheck.empty_cells + ' 个' : '未通过（见提示）') : '检查空格、名单一致性，避免整份被拒', precheck ? (precheck.ok ? 'done' : 'err') : (busy === 'precheck' ? 'busy' : 'todo'), precheck ? null : doPrecheck, busy === 'precheck' ? h(Spinner) : '预检', busyAny || !filled),
                step(4, '导入成绩', '提交到平台（source=全通教育，后台异步导入）', 'todo', doImport, busy === 'import' ? h(Spinner) : '导入', busyAny || !filled || (precheck && !precheck.ok)),
                step(5, '核对回执', receipts ? '成功 ' + receipts.successCount + ' 条' + (receipts.failCount ? '、失败 ' + receipts.failCount + ' 条' : '') : '查看平台消息回执，确认真的收下', receipts ? (receipts.failCount ? 'err' : 'done') : (busy === 'receipt' ? 'busy' : 'todo'), () => doReceipt(null), busy === 'receipt' ? h(Spinner) : '核对回执', busyAny),
              ),
            ),

            // 预检详情
            precheck && !precheck.ok ? h(Alert, {
              kind: 'warn', title: '预检未通过（平台对空格与超分值零容忍）',
              message: [
                precheck.blank_rows && precheck.blank_rows.length ? '整行空 ' + precheck.blank_rows.length + ' 人：' + precheck.blank_rows.slice(0, 10).join('、') : '',
                precheck.partial_rows && precheck.partial_rows.length ? '部分空 ' + precheck.partial_rows.length + ' 人（每人缺若干列）' : '',
                precheck.extra_in_scores && precheck.extra_in_scores.length ? '对照表外 ' + precheck.extra_in_scores.length + ' 人：' + precheck.extra_in_scores.slice(0, 10).join('、') : '',
                precheck.over_limit && precheck.over_limit.length
                  ? '分值超上限 ' + precheck.over_limit_cells + ' 格（平台会整份拒收）：' +
                    precheck.over_limit.map((o) => '第' + o.question + '题满分' + o.maxScore + '，超限' + o.count + '人（' + o.students.slice(0, 3).join('、') + '）').join('；')
                  : '',
                precheck.no_subscores ? '整科无小题分' : '',
              ].filter(Boolean).join('；'),
            }) : null,

            // 满分校验未生效时的提示（不阻塞，但要说清楚）
            precheck && precheck.maxScoreWarning ? h(Alert, { kind: 'warn', message: precheck.maxScoreWarning }) : null,

            // 回执列表
            receipts && receipts.matched && receipts.matched.length ? h('div', { className: 'fli-section' },
              h('div', { className: 'fli-section-head' }, h('h2', { className: 'fli-section-title' }, '平台回执')),
              // 本次导入的明确结论（只按本次时间窗统计，历史回执不计入）
              receipts.successCount > 0 && receipts.failCount === 0
                ? h(Alert, {
                    kind: 'ok',
                    title: '本次导入成功',
                    message: '平台已收下，共 ' + receipts.successCount + ' 条回执：' +
                      (receipts.matched.filter((r) => r.success && r.students != null)
                        .map((r) => '导入学生 ' + r.students + ' 人').join('；') || '见下表'),
                  })
                : receipts.failCount > 0
                  ? h(Alert, {
                      kind: 'error',
                      title: '本次导入有 ' + receipts.failCount + ' 条被平台拒收',
                      message: receipts.matched.filter((r) => !r.success).map((r) => r.error).join('；'),
                    })
                  : null,
              h('div', { className: 'fli-table-wrap' },
                h('div', { className: 'fli-table-scroll' },
                  h('table', { className: 'fli-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, '时间(UTC)'), h('th', null, '文件'), h('th', null, '结果'), h('th', null, '详情'))),
                    h('tbody', null, receipts.matched.map((r, i) => h('tr', { key: i },
                      h('td', null, (r.createAt || '').replace('T', ' ').slice(0, 19)),
                      h('td', null, r.file || '—'),
                      h('td', null, r.success ? '成功' : '失败'),
                      h('td', null, r.success ? ('导入学生：' + (r.students != null ? r.students : '—')) : r.error),
                    ))),
                  ),
                ),
              ),
            ) : null,

            // 操作日志
            log.length ? h('div', { className: 'fli-section' },
              h('div', { className: 'fli-section-head' }, h('h2', { className: 'fli-section-title' }, '操作日志')),
              h('div', { className: 'fli-log' },
                log.map((row, i) => h('div', { key: i, className: 'fli-log-row' + (row.kind === 'err' ? ' is-err' : row.kind === 'ok' ? ' is-ok' : '') },
                  h('span', { className: 'fli-log-time' }, row.t),
                  h('span', { className: 'fli-log-msg' }, row.msg),
                )),
              ),
            ) : null,
          ),
        ),
      )
    }

    function step(no, title, meta, status, onClick, actionLabel, disabled) {
      const dotClass = 'fli-step-dot fli-step-dot--' + status
      const dotText = status === 'done' ? '✓' : status === 'err' ? '✕' : no
      return h('div', { className: 'fli-step' },
        h('span', { className: dotClass }, dotText),
        h('div', { className: 'fli-step-main' },
          h('div', { className: 'fli-step-title' }, title),
          h('div', { className: 'fli-step-meta' }, meta),
        ),
        onClick ? h('div', { className: 'fli-step-actions' },
          h('button', { className: 'fli-btn fli-btn--ghost fli-btn--small', disabled: Boolean(disabled), onClick }, actionLabel),
        ) : null,
      )
    }

    // ---------------------------------------------------------------- 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 21,
              label: function () {
                return '导入成绩'
              },
            },
            PanelIcon,
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            ImportPage,
          )
        })
      },
    }
  },
})
