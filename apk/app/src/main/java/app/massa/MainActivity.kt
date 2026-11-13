package app.massa

import android.content.Context
import android.os.Bundle
import android.view.View
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView

/**
 * Оболочка MASSA: GeckoView показывает интерфейс, который лежит в APK
 * (assets/web). Сеть нужна только для данных.
 *
 * GeckoRuntime — единственный на процесс, поэтому храним его в companion:
 * при пересоздании активности его нельзя создавать заново.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private var runtime: GeckoRuntime? = null
        private var session: GeckoSession? = null

        private fun ensureRuntime(context: Context): GeckoRuntime {
            runtime?.let { return it }

            val settings = GeckoRuntimeSettings.Builder()
                .remoteDebuggingEnabled(true)
                .consoleOutput(true)
                .build()

            val created = GeckoRuntime.create(context.applicationContext, settings)
            runtime = created
            return created
        }

        private fun ensureSession(context: Context): GeckoSession {
            session?.let { return it }

            // мобильный viewport: масштаб запрещён, страница подгоняется под экран
            val sessionSettings = GeckoSessionSettings.Builder()
                .viewportMode(GeckoSessionSettings.VIEWPORT_MODE_MOBILE)
                .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_MOBILE)
                .build()

            val created = GeckoSession(sessionSettings)
            created.open(ensureRuntime(context))
            session = created
            return created
        }
    }

    private lateinit var server: LocalAssetsServer

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // интерфейс рисуем сами и отступаем от системных панелей
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_main)

        val root = findViewById<View>(R.id.main)

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        server = LocalAssetsServer(this)
        server.start()

        val gecko = findViewById<GeckoView>(R.id.gecko)
        val loading = findViewById<View>(R.id.loading)

        val current = ensureSession(this)

        current.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStart(session: GeckoSession, url: String) {
                loading.visibility = View.VISIBLE
            }

            override fun onPageStop(session: GeckoSession, success: Boolean) {
                loading.visibility = View.GONE
            }
        }

        gecko.setSession(current)

        val url = "http://127.0.0.1:${server.port}/index.html"

        if (!current.isOpen) current.open(ensureRuntime(this))
        current.loadUri(url)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                current.goBack()
            }
        })
    }

    override fun onDestroy() {
        server.stop()
        super.onDestroy()
    }
}
