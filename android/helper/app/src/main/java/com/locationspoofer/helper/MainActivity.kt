package com.locationspoofer.helper

import android.app.Activity
import android.os.Bundle

/** Shown so the app is listed in Developer options. It does not set a location. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }
}
