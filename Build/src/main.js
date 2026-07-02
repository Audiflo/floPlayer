import { Updato } from "@nellowtcs/updato";
import { UpdateNotification } from "@nellowtcs/updato/update-ui";
import init, { decode, info, get_metadata, get_cover_art, get_synced_lyrics } from 'https://esm.sh/@flo-audio/libflo-audio@0.1.2';

// Keep
const updater = Updato.init(
  {
    repo: "Audiflo/floPlayer",
    mode: "version",
    current: "0.1.0",
  },
  {
    onUpdate: (info) => {
      new UpdateNotification(updater, {
        heading: `v${info.latest} ready`,
      }).show(info);
    },
    onError: (err) => console.warn("Updato:", err.message),
    onProgress: (pct, file) => console.log(`Updato: ${pct}% - ${file}`),
  },
);




        const DB_NAME = 'FloPlayerDB';
        const DB_VERSION = 2; // Incremented for 'tracks' store
        let db;


        const state = {
            audioCtx: null, source: null, gainNode: null, analyser: null, buffer: null,
            isPlaying: false, startTime: 0, pausedAt: 0, wasmLoaded: false,
            
            queue: [], // Array of track objects (DB records or Files)
            currentIndex: -1, shuffledIndices: [],
            libraryCache: [], // Cache for search
            
            shuffle: localStorage.getItem('flo_shuffle') === 'true',
            repeat: localStorage.getItem('flo_repeat') || 'off',
            volume: parseFloat(localStorage.getItem('flo_volume') || '0.8'),
            
            currentCoverUrl: null, lyrics: null, currentLyricIdx: -1, isAnimatedCover: false,
            view: 'overview', currentTrackId: null
        };

        const ui = {
            // Buttons
            playBtn: document.getElementById('btn-play'),
            playBtnHero: document.getElementById('btn-play-hero'),
            playIcon: document.getElementById('play-icon'),
            playIconHero: document.getElementById('play-icon-hero'),
            prevBtn: document.getElementById('btn-prev'),
            nextBtn: document.getElementById('btn-next'),
            shuffleBtn: document.getElementById('btn-shuffle'),
            repeatBtn: document.getElementById('btn-repeat'),
            likeBtnHero: document.getElementById('btn-like-hero'),
            likeBtnFooter: document.getElementById('btn-like-footer'),
            lyricsBtn: document.getElementById('btn-lyrics'),
            queueBtn: document.getElementById('btn-queue'),
            
            // Nav
            navHome: document.getElementById('nav-home'),
            navSearch: document.getElementById('nav-search'),
            navLib: document.getElementById('nav-library'),
            
            // Inputs
            fileInput: document.getElementById('file-input'),
            dropZone: document.getElementById('drop-zone'),
            progressBar: document.getElementById('progress-bar'),
            progressHandle: document.getElementById('progress-handle'),
            progressContainer: document.getElementById('progress-container'),
            currentTime: document.getElementById('current-time'),
            totalTime: document.getElementById('total-time'),
            volumeSlider: document.getElementById('volume-slider'),
            canvas: document.getElementById('visualizer'),
            searchInput: document.getElementById('search-input'),
            
            // Views & Lists
            viewOverview: document.getElementById('view-overview'),
            viewLibrary: document.getElementById('view-library'),
            viewLyrics: document.getElementById('view-lyrics'),
            viewQueue: document.getElementById('view-queue'),
            queuePreviewList: document.getElementById('queue-preview-list'),
            queueFullList: document.getElementById('queue-full-list'),
            libraryList: document.getElementById('library-list'),
            libCount: document.getElementById('lib-count'),

            // Metadata
            title: document.getElementById('track-title'),
            artist: document.getElementById('track-artist'),
            album: document.getElementById('track-album'),
            footerTitle: document.getElementById('footer-title'),
            footerArtist: document.getElementById('footer-artist'),
            
            // Specs
            channels: document.getElementById('meta-channels'),
            rate: document.getElementById('meta-rate'),
            size: document.getElementById('meta-size'),
            type: document.getElementById('meta-type'),
            
            // Art
            cover: document.getElementById('cover-img'),
            coverIcon: document.getElementById('cover-icon'),
            footerCover: document.getElementById('footer-cover'),
            footerIcon: document.getElementById('footer-icon'),
            lyricsContent: document.getElementById('lyrics-content')
        };

        const ctx = ui.canvas.getContext('2d');
        function log(msg) { console.log(`[FloPlayer] ${msg}`); }

        async function initDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onerror = (e) => reject("IndexedDB error");
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('likes')) {
                        db.createObjectStore('likes', { keyPath: 'id' });
                    }
                    // Persist actual files. keyPath auto-increment for simple ID
                    if (!db.objectStoreNames.contains('tracks')) {
                        const trackStore = db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
                        trackStore.createIndex('added', 'added', { unique: false });
                    }
                };
                request.onsuccess = (e) => {
                    db = e.target.result;
                    resolve(db);
                };
            });
        }

        async function initializeWasm() {
            if (state.wasmLoaded) return;
            try {
                await init();
                state.wasmLoaded = true;
                log('WASM Ready');
            } catch (err) {
                console.error(err);
            }
        }

        async function importFiles(fileList) {
            await initializeWasm();
            if (!db) await initDB();
            
            const files = Array.from(fileList).filter(f => f.name.endsWith('.flo'));
            const processedRecords = [];

            // 1. Process files asynchronously OUTSIDE the transaction loop
            for (const file of files) {
                let meta = { title: file.name.replace('.flo', ''), artist: 'Unknown', album: '', duration: 0 };
                try {
                    const arrayBuffer = await file.arrayBuffer(); // Await is safe here now
                    const uint8Array = new Uint8Array(arrayBuffer);
                    const parsed = get_metadata(uint8Array);
                    if (parsed) {
                        meta.title = parsed.title || meta.title;
                        meta.artist = parsed.artist || meta.artist;
                        meta.album = parsed.album || meta.album;
                    }
                    const infoData = info(uint8Array);
                    meta.duration = infoData.duration_secs;
                } catch (e) { console.warn("Meta parse error on import", e); }

                processedRecords.push({
                    file: file, // Store the Blob
                    title: meta.title,
                    artist: meta.artist,
                    album: meta.album,
                    duration: meta.duration,
                    added: Date.now()
                });
            }

            // 2. Open transaction and batch save synchronously
            const transaction = db.transaction(['tracks'], 'readwrite');
            const store = transaction.objectStore('tracks');
            let addedCount = 0;

            for (const record of processedRecords) {
                store.add(record);
                state.queue.push(record); // Add to current session queue
                addedCount++;
            }

            if (addedCount > 0) {
                // Wait for transaction complete if needed, but UI update can happen
                await refreshLibrary();
                renderQueue();
                if (!state.isPlaying && state.queue.length === addedCount) {
                    window.playQueueIndex(0);
                }
                changeView('library');
            }
        }

        async function refreshLibrary() {
            if (!db) return;
            return new Promise((resolve) => {
                const transaction = db.transaction(['tracks'], 'readonly');
                const store = transaction.objectStore('tracks');
                const request = store.getAll();
                
                request.onsuccess = () => {
                    state.libraryCache = request.result; // Cache for searching
                    // Sort by added desc
                    state.libraryCache.sort((a,b) => b.added - a.added);
                    renderLibrary(state.libraryCache);
                    ui.libCount.textContent = `${state.libraryCache.length} songs`;
                    resolve();
                };
            });
        }

        function renderLibrary(tracks) {
            if (tracks.length === 0) {
                ui.libraryList.innerHTML = `<div class="px-4 py-20 text-center text-gray-500"><p>No results found.</p></div>`;
                return;
            }

            const html = tracks.map((t, i) => `
                <div onclick="playLibraryTrack(${t.id})" class="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_1fr_auto] gap-4 items-center px-4 py-3 hover:bg-white/10 rounded group cursor-pointer text-sm text-gray-400 hover:text-white transition-colors">
                    <span class="w-8 text-center group-hover:hidden">${i + 1}</span>
                    <span class="w-8 text-center hidden group-hover:block text-white"><i class="fa-solid fa-play"></i></span>
                    
                    <div class="flex items-center gap-3 overflow-hidden">
                        <div class="flex flex-col min-w-0">
                            <span class="text-white font-medium truncate">${t.title}</span>
                            <span class="md:hidden text-xs truncate">${t.artist}</span>
                        </div>
                    </div>
                    
                    <span class="hidden md:block truncate">${t.artist}</span>
                    <span class="hidden md:block truncate text-xs">${new Date(t.added).toLocaleDateString()}</span>
                    <span class="text-right font-mono text-xs">${formatTime(t.duration)}</span>
                </div>
            `).join('');
            
            ui.libraryList.innerHTML = html;
        }

        window.playLibraryTrack = (id) => {
            // Find track in cache
            const track = state.libraryCache.find(t => t.id === id);
            if (!track) return;
            
            // Logic: Playing from library replaces queue or adds to it?
            // Spotify style: Plays track, queue continues from library context.
            // For simplicity: Add entire library to queue, set index to this track.
            state.queue = [...state.libraryCache];
            state.currentIndex = state.queue.findIndex(t => t.id === id);
            
            if (state.shuffle) {
                // Re-shuffle based on new queue
                generateShuffleIndices();
            }
            
            renderQueue();
            loadTrack(track);
        };

        function filterLibrary() {
            const term = ui.searchInput.value.toLowerCase();
            if (!term) {
                renderLibrary(state.libraryCache);
                return;
            }
            const filtered = state.libraryCache.filter(t => 
                t.title.toLowerCase().includes(term) || 
                t.artist.toLowerCase().includes(term) ||
                t.album.toLowerCase().includes(term)
            );
            renderLibrary(filtered);
        }

        function generateShuffleIndices() {
            state.shuffledIndices = state.queue.map((_, i) => i);
            for (let i = state.shuffledIndices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [state.shuffledIndices[i], state.shuffledIndices[j]] = [state.shuffledIndices[j], state.shuffledIndices[i]];
            }
        }

        function renderQueue() {
            const listContent = state.queue.map((t, idx) => {
                const isActive = idx === state.currentIndex;
                const activeClass = isActive ? 'text-green-500' : 'text-white';
                const playingIcon = isActive && state.isPlaying ? '<i class="fa-solid fa-chart-simple animate-pulse"></i>' : (idx + 1);
                
                return `
                    <div onclick="window.playQueueIndex(${idx})" class="flex items-center justify-between ${activeClass} hover:bg-white/10 px-4 py-2 rounded cursor-pointer group transition-colors">
                        <div class="flex items-center gap-4 min-w-0">
                            <span class="w-4 text-center text-sm">${playingIcon}</span>
                            <div class="flex flex-col min-w-0">
                                <span class="font-medium truncate">${t.title}</span>
                                <span class="text-xs text-gray-400 truncate">${t.artist}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            const emptyMsg = '<div class="px-4 py-8 text-center text-gray-500 text-sm">Queue is empty.</div>';
            ui.queuePreviewList.innerHTML = listContent || emptyMsg;
            ui.queueFullList.innerHTML = listContent || emptyMsg;
        }

        window.playQueueIndex = async (index) => {
            if (index < 0 || index >= state.queue.length) return;
            state.currentIndex = index;
            await loadTrack(state.queue[index]);
        };

        async function loadTrack(trackRecord) {
            if (!state.wasmLoaded) await initializeWasm();

            // Stop previous
            if (state.source) { try { state.source.stop(); } catch(e){} state.source = null; }
            state.isPlaying = false; state.pausedAt = 0; state.buffer = null; state.lyrics = null; state.currentLyricIdx = -1; state.isAnimatedCover = false;
            
            // Reset UI
            ui.playBtn.disabled = true; ui.title.textContent = "Loading...";
            if (state.currentCoverUrl) URL.revokeObjectURL(state.currentCoverUrl);
            ui.cover.src = ""; ui.cover.classList.add('hidden'); ui.coverIcon.classList.remove('hidden');
            ui.footerCover.src = ""; ui.footerCover.classList.add('hidden'); ui.footerIcon.classList.remove('hidden');
            ui.lyricsContent.innerHTML = '<div class="h-full flex items-center justify-center text-gray-500 font-bold text-2xl">Lyrics will appear here</div>';

            // Get File Blob (it might be in .file property from DB or direct File object)
            const fileBlob = trackRecord.file || trackRecord;
            
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const uint8Array = new Uint8Array(e.target.result);
                    const fileInfo = info(uint8Array);

                    // Update UI with stored or fresh meta
                    let title = trackRecord.title || fileBlob.name.replace('.flo', '');
                    let artist = trackRecord.artist || "Unknown Artist";
                    let album = trackRecord.album || "Unknown Album";
                    
                    // Parse fresh meta for Cover Art & Lyrics (we don't store those in DB to save space/complexity)
                    try {
                        const meta = get_metadata(uint8Array);
                        if (meta) {
                            if (meta.animated_cover?.data) {
                                const ac = meta.animated_cover;
                                const blob = new Blob([ac.data], { type: ac.mime_type || 'image/gif' });
                                state.currentCoverUrl = URL.createObjectURL(blob);
                                setCover(state.currentCoverUrl);
                                state.isAnimatedCover = true;
                            }
                        }
                    } catch(e) {}

                    ui.title.textContent = title; ui.artist.textContent = artist; ui.album.textContent = album;
                    ui.footerTitle.textContent = title; ui.footerArtist.textContent = artist;
                    
                    // Specs
                    ui.channels.textContent = fileInfo.channels;
                    ui.rate.textContent = `${fileInfo.sample_rate}Hz`;
                    ui.type.textContent = fileInfo.is_lossy ? "Lossy" : "Lossless";
                    ui.size.textContent = `${(fileBlob.size/1024/1024).toFixed(1)} MB`;

                    // Likes
                    state.currentTrackId = `${title}-${artist}`;
                    checkLikeStatus();

                    // Static Cover
                    if (!state.isAnimatedCover) {
                        try {
                            const cover = get_cover_art(uint8Array);
                            if (cover?.data?.length > 0) {
                                const blob = new Blob([cover.data], { type: cover.mime_type || 'image/jpeg' });
                                state.currentCoverUrl = URL.createObjectURL(blob);
                                setCover(state.currentCoverUrl);
                            }
                        } catch(e) {}
                    }

                    // Lyrics
                    try {
                        let lyricsRes = get_synced_lyrics(uint8Array);
                        let lyricsList = null;
                        if (Array.isArray(lyricsRes) && lyricsRes.length > 0) lyricsList = lyricsRes[0].lines || lyricsRes;
                        else if (lyricsRes && lyricsRes.lines) lyricsList = lyricsRes.lines;

                        if (lyricsList && lyricsList.length > 0) {
                            state.lyrics = lyricsList;
                            renderLyrics(lyricsList);
                        }
                    } catch(e) {}

                    // Decode
                    const interleavedSamples = decode(uint8Array);
                    initAudioContext();
                    const audioBuffer = state.audioCtx.createBuffer(fileInfo.channels, interleavedSamples.length / fileInfo.channels, fileInfo.sample_rate);
                    for (let ch = 0; ch < fileInfo.channels; ch++) {
                        const chData = audioBuffer.getChannelData(ch);
                        for (let i = 0; i < chData.length; i++) chData[i] = interleavedSamples[i * fileInfo.channels + ch];
                    }

                    state.buffer = audioBuffer;
                    ui.totalTime.textContent = formatTime(audioBuffer.duration);
                    
                    ui.playBtn.disabled = false;
                    renderQueue();
                    playAudio();

                } catch (err) {
                    console.error(err);
                    ui.title.textContent = "Error Loading File";
                }
            };
            reader.readAsArrayBuffer(fileBlob);
        }

        window.changeView = (view, focusSearch = false) => {
            state.view = view;
            // Hide all
            ui.viewOverview.classList.add('hidden');
            ui.viewLibrary.classList.add('hidden');
            ui.viewLyrics.classList.add('hidden');
            ui.viewQueue.classList.add('hidden');
            
            // Reset Nav Styles
            ui.navHome.classList.remove('nav-active');
            ui.navSearch.classList.remove('nav-active');
            ui.navLib.classList.remove('nav-active');
            ui.lyricsBtn.classList.remove('btn-active');
            ui.queueBtn.classList.remove('btn-active');

            if (view === 'overview') {
                ui.viewOverview.classList.remove('hidden');
                ui.navHome.classList.add('nav-active');
            }
            else if (view === 'library') {
                ui.viewLibrary.classList.remove('hidden');
                refreshLibrary(); // Ensure up to date
                ui.navLib.classList.add('nav-active');
                if (focusSearch) {
                    ui.navSearch.classList.add('nav-active'); // Highlight search instead
                    ui.navLib.classList.remove('nav-active');
                    setTimeout(() => ui.searchInput.focus(), 50);
                }
            }
            else if (view === 'lyrics') {
                ui.viewLyrics.classList.remove('hidden');
                ui.lyricsBtn.classList.add('btn-active');
                if(state.isPlaying) updateLyrics((state.audioCtx.currentTime - state.startTime)*1000);
            }
            else if (view === 'queue') {
                ui.viewQueue.classList.remove('hidden');
                ui.queueBtn.classList.add('btn-active');
            }
        };

        function toggleShuffle() {
            state.shuffle = !state.shuffle;
            localStorage.setItem('flo_shuffle', state.shuffle);
            if (state.shuffle) generateShuffleIndices();
            updateControlsUI();
        }

        function toggleRepeat() {
            const modes = ['off', 'all', 'one'];
            state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
            localStorage.setItem('flo_repeat', state.repeat);
            updateControlsUI();
        }
        
        function updateControlsUI() {
            // Shuffle
            ui.shuffleBtn.classList.toggle('btn-active', state.shuffle);
            ui.shuffleBtn.classList.toggle('btn-active-dot', state.shuffle);
            
            // Repeat
            ui.repeatBtn.className = 'hover:text-white transition-colors'; // reset
            ui.repeatBtn.innerHTML = '<i class="fa-solid fa-repeat text-sm"></i>';
            if (state.repeat === 'all') {
                ui.repeatBtn.classList.add('btn-active', 'btn-active-dot');
            } else if (state.repeat === 'one') {
                ui.repeatBtn.classList.add('btn-active', 'btn-active-dot');
                ui.repeatBtn.innerHTML += '<span class="absolute -top-1 -right-1 text-[8px] font-bold">1</span>';
            }
            
            ui.nextBtn.disabled = state.queue.length <= 1;
            ui.prevBtn.disabled = state.queue.length <= 1;
        }

        function playNext(auto = false) {
            if (state.queue.length === 0) return;
            if (auto && state.repeat === 'one') { state.pausedAt = 0; playAudio(); return; }

            let nextIdx;
            if (state.shuffle) {
                const currentShuffledIdx = state.shuffledIndices.indexOf(state.currentIndex);
                if (currentShuffledIdx === -1 || currentShuffledIdx === state.shuffledIndices.length - 1) {
                    if (state.repeat === 'all' || !auto) nextIdx = state.shuffledIndices[0]; else return;
                } else nextIdx = state.shuffledIndices[currentShuffledIdx + 1];
            } else {
                if (state.currentIndex === state.queue.length - 1) {
                    if (state.repeat === 'all' || !auto) nextIdx = 0; else return;
                } else nextIdx = state.currentIndex + 1;
            }
            if (nextIdx !== undefined) window.playQueueIndex(nextIdx);
        }

        function playPrev() {
            if (state.isPlaying && (state.audioCtx.currentTime - state.startTime) > 3) { seek(0); return; }
            let prevIdx;
            if (state.shuffle) {
                 const currentShuffledIdx = state.shuffledIndices.indexOf(state.currentIndex);
                 if (currentShuffledIdx <= 0) prevIdx = state.shuffledIndices[state.shuffledIndices.length - 1];
                 else prevIdx = state.shuffledIndices[currentShuffledIdx - 1];
            } else {
                if (state.currentIndex <= 0) prevIdx = state.queue.length - 1; else prevIdx = state.currentIndex - 1;
            }
            window.playQueueIndex(prevIdx);
        }

        // --- Standard Audio Funcs ---
        function initAudioContext() {
            if (!state.audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                state.audioCtx = new AC();
                state.gainNode = state.audioCtx.createGain();
                state.analyser = state.audioCtx.createAnalyser();
                state.gainNode.connect(state.analyser);
                state.analyser.connect(state.audioCtx.destination);
                state.analyser.fftSize = 256;
                state.gainNode.gain.value = state.volume;
                ui.volumeSlider.value = state.volume;
            }
        }
        function playAudio() {
            if (state.isPlaying) { pauseAudio(); return; }
            if (!state.buffer) return;
            if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
            state.source = state.audioCtx.createBufferSource();
            state.source.buffer = state.buffer;
            state.source.connect(state.gainNode);
            state.startTime = state.audioCtx.currentTime - state.pausedAt;
            state.source.start(0, state.pausedAt);
            state.isPlaying = true;
            updatePlayButtons(true); renderQueue();
            state.source.onended = () => { if (state.isPlaying && (state.audioCtx.currentTime - state.startTime) >= state.buffer.duration - 0.2) playNext(true); };
            drawVisualizer(); requestAnimationFrame(updateLoop);
        }
        function pauseAudio() {
            if (!state.isPlaying || !state.source) return;
            state.source.stop(); state.pausedAt = state.audioCtx.currentTime - state.startTime;
            state.isPlaying = false; updatePlayButtons(false); renderQueue();
        }
        function seek(pct) {
            if (!state.buffer) return;
            const t = state.buffer.duration * pct;
            if (state.isPlaying) { try{state.source.stop();}catch(e){} state.pausedAt = t; state.isPlaying=false; playAudio(); }
            else { state.pausedAt = t; updateProgress(); }
        }
        function updatePlayButtons(on) {
            const cls = on ? "fa-pause" : "fa-play"; const pl = on ? "" : "pl-0.5";
            ui.playIcon.className = `fa-solid ${cls} text-sm ${pl}`;
            ui.playIconHero.className = `fa-solid ${cls} text-2xl`;
        }
        function updateProgress() {
            if(!state.buffer) return;
            const t = state.isPlaying ? state.audioCtx.currentTime - state.startTime : state.pausedAt;
            const cur = Math.max(0, Math.min(t, state.buffer.duration));
            ui.currentTime.textContent = formatTime(cur);
            const pct = (cur/state.buffer.duration)*100;
            ui.progressBar.style.width = `${pct}%`; ui.progressHandle.style.left = `${pct}%`;
            updateLyrics(cur*1000);
        }
        function formatTime(s){ return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`; }
        function setCover(url) {
            ui.cover.src=url; ui.cover.classList.remove('hidden'); ui.coverIcon.classList.add('hidden');
            ui.footerCover.src=url; ui.footerCover.classList.remove('hidden'); ui.footerIcon.classList.add('hidden');
        }
        function checkLikeStatus() {
            if (!db || !state.currentTrackId) return;
            db.transaction(['likes']).objectStore('likes').get(state.currentTrackId).onsuccess = (e) => {
                const liked = !!e.target.result;
                const cls = liked ? "fa-solid fa-heart" : "fa-regular fa-heart";
                [ui.likeBtnHero, ui.likeBtnFooter].forEach(b => {
                    b.innerHTML = `<i class="${cls} text-2xl sm:text-lg"></i>`;
                    b.classList.toggle('like-active', liked);
                });
            };
        }
        function toggleLike() {
            if (!db || !state.currentTrackId) return;
            const s = db.transaction(['likes'], 'readwrite').objectStore('likes');
            s.get(state.currentTrackId).onsuccess = (e) => {
                if (e.target.result) s.delete(state.currentTrackId);
                else s.add({ id: state.currentTrackId, date: Date.now() });
                checkLikeStatus();
            };
        }
        // Visuals
        function renderLyrics(lyrics) {
            ui.lyricsContent.innerHTML = '';
            ui.lyricsContent.appendChild(Object.assign(document.createElement('div'), {style:'height:45vh'}));
            lyrics.forEach((l,i) => {
                const d = document.createElement('div');
                d.textContent = l.text; d.className = 'lyric-line lyric-entry';
                d.onclick = () => seek((l.timestamp_ms/1000)/state.buffer.duration);
                ui.lyricsContent.appendChild(d);
            });
            ui.lyricsContent.appendChild(Object.assign(document.createElement('div'), {style:'height:45vh'}));
        }
        function updateLyrics(ms) {
            if (!state.lyrics || state.view !== 'lyrics') return;
            let idx = -1; for(let i=0; i<state.lyrics.length; i++) if(state.lyrics[i].timestamp_ms <= ms) idx=i; else break;
            if (idx !== state.currentLyricIdx) {
                state.currentLyricIdx = idx;
                const els = ui.lyricsContent.querySelectorAll('.lyric-entry');
                els.forEach((el, i) => {
                    if (i===idx) { el.classList.add('lyric-active'); el.classList.remove('lyric-line'); el.scrollIntoView({behavior:'smooth', block:'center'}); }
                    else { el.classList.remove('lyric-active'); el.classList.add('lyric-line'); }
                });
            }
        }
        function drawVisualizer() {
            if (!state.isPlaying) return;
            requestAnimationFrame(drawVisualizer);
            const len = state.analyser.frequencyBinCount;
            const data = new Uint8Array(len); state.analyser.getByteFrequencyData(data);
            const w = ui.canvas.width = ui.canvas.offsetWidth; const h = ui.canvas.height = ui.canvas.offsetHeight;
            ctx.clearRect(0,0,w,h); ctx.lineWidth=2; ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.beginPath();
            const slice = w/len; let x=0;
            for(let i=0; i<len; i++) {
                const v = data[i]/128.0; const y = (h-(v*h/3))-10;
                i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); x+=slice;
            }
            ctx.stroke();
        }
        function updateLoop() { if(state.isPlaying){ updateProgress(); requestAnimationFrame(updateLoop); } }

        window.addEventListener('load', async () => {
            await initializeWasm();
            await initDB();
            updateControlsUI();
            refreshLibrary(); // Load saved tracks on start
        });
        
        ui.searchInput.addEventListener('input', filterLibrary);
        
        // Drag Drop
        window.addEventListener('dragover', e => { e.preventDefault(); ui.dropZone.style.display='flex'; });
        ui.dropZone.addEventListener('dragleave', e => { e.preventDefault(); ui.dropZone.style.display='none'; });
        ui.dropZone.addEventListener('drop', e => {
            e.preventDefault(); ui.dropZone.style.display='none';
            if(e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
        });
        ui.fileInput.addEventListener('change', e => { if(e.target.files.length) importFiles(e.target.files); });

        // Bind Controls
        ui.playBtn.onclick = playAudio; ui.playBtnHero.onclick = playAudio;
        ui.nextBtn.onclick = () => playNext(false); ui.prevBtn.onclick = playPrev;
        ui.shuffleBtn.onclick = toggleShuffle; ui.repeatBtn.onclick = toggleRepeat;
        ui.likeBtnHero.onclick = toggleLike; ui.likeBtnFooter.onclick = toggleLike;
        ui.lyricsBtn.onclick = () => changeView(state.view==='lyrics'?'overview':'lyrics');
        ui.queueBtn.onclick = () => changeView(state.view==='queue'?'overview':'queue');
        ui.progressContainer.onclick = e => { if(state.buffer) seek((e.clientX - ui.progressContainer.getBoundingClientRect().left)/ui.progressContainer.getBoundingClientRect().width); };
        ui.volumeSlider.oninput = e => {
            state.volume = e.target.value; localStorage.setItem('flo_volume', state.volume);
            if(state.gainNode) state.gainNode.gain.value = state.volume;
            ui.playBtn.parentElement.parentElement.parentElement.querySelector('#vol-icon').className = 
                e.target.value == 0 ? "fa-solid fa-volume-xmark text-sm" : "fa-solid fa-volume-high text-sm";
        };
